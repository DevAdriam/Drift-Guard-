import type { ColumnDiffItem, MigrationFinding } from '../types/telemetry.ts';

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function splitStatements(sql: string): string[] {
  return stripSqlComments(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function analyzeMigrationSql(rawSql: string): {
  riskLevel: 'SAFE' | 'WARNING' | 'BLOCKED';
  findings: MigrationFinding[];
  wrappedSafeSql: string;
} {
  const statements = splitStatements(rawSql);
  const findings: MigrationFinding[] = [];
  const lowerAll = stripSqlComments(rawSql).toLowerCase();

  let hasLockTimeout = /set\s+(local\s+)?lock_timeout\s*=/.test(lowerAll);
  let hasStatementTimeout = /set\s+(local\s+)?statement_timeout\s*=/.test(
    lowerAll
  );

  for (const stmt of statements) {
    const preview = stmt.length > 160 ? `${stmt.slice(0, 160)}…` : stmt;

    // 1. CREATE INDEX without CONCURRENTLY
    if (
      /^create\s+(unique\s+)?index\b/i.test(stmt) &&
      !/\bconcurrently\b/i.test(stmt)
    ) {
      const rewrite = stmt.replace(
        /^create\s+(unique\s+)?index\b/i,
        (m) => `${m} CONCURRENTLY`
      );
      findings.push({
        ruleId: 'PG-LOCK-001',
        severity: 'CRITICAL',
        title: 'Blocking Index Creation (Missing CONCURRENTLY)',
        plainEnglishImpact:
          'Building a normal index blocks all INSERT, UPDATE, and DELETE writes on the table until the build finishes.',
        lockLevel: 'SHARE',
        statementPreview: preview,
        recommendation:
          'Use CREATE INDEX CONCURRENTLY outside a transaction block so customer writes keep flowing.',
        safeRewrite: `${rewrite};`,
      });
    }

    // 2. DROP INDEX without CONCURRENTLY
    if (/^drop\s+index\b/i.test(stmt) && !/\bconcurrently\b/i.test(stmt)) {
      const rewrite = stmt.replace(
        /^drop\s+index\b/i,
        'DROP INDEX CONCURRENTLY'
      );
      findings.push({
        ruleId: 'PG-LOCK-002',
        severity: 'WARNING',
        title: 'Blocking Index Drop (Missing CONCURRENTLY)',
        plainEnglishImpact:
          'Dropping an index without CONCURRENTLY briefly freezes all reads and writes on the table.',
        lockLevel: 'ACCESS EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'Add CONCURRENTLY to drop the index safely without blocking live queries.',
        safeRewrite: `${rewrite};`,
      });
    }

    // 3. ALTER TABLE ... ALTER COLUMN ... TYPE
    if (
      /^alter\s+table\b/i.test(stmt) &&
      /\balter\s+(column\s+)?[\w".]+\s+(set\s+data\s+)?type\b/i.test(stmt)
    ) {
      findings.push({
        ruleId: 'PG-LOCK-003',
        severity: 'CRITICAL',
        title: 'Column Type Change Causes Full Table Rewrite',
        plainEnglishImpact:
          'Changing a column type locks the entire table (blocking all reads & writes) while PostgreSQL rewrites every row on disk.',
        lockLevel: 'ACCESS EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'Use the Expand-and-Contract pattern: add a new nullable column, backfill in batches, swap app reads/writes, then drop the old column.',
      });
    }

    // 4. ALTER TABLE ... ADD COLUMN ... NOT NULL without DEFAULT
    if (
      /^alter\s+table\b/i.test(stmt) &&
      /\badd\s+(column\s+)?/i.test(stmt) &&
      /\bnot\s+null\b/i.test(stmt) &&
      !/\bdefault\b/i.test(stmt)
    ) {
      findings.push({
        ruleId: 'PG-DATA-001',
        severity: 'CRITICAL',
        title: 'Adding NOT NULL Column Without Default Value',
        plainEnglishImpact:
          'This migration will immediately fail on any non-empty table because existing rows have no value for the new required column.',
        lockLevel: 'ACCESS EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'Add the column as nullable first (or supply a constant DEFAULT on PostgreSQL 11+), backfill existing rows, then enforce NOT NULL via a NOT VALID check constraint.',
      });
    }

    // 5. ALTER TABLE ... ADD COLUMN ... DEFAULT volatile function (random, clock_timestamp, etc.)
    if (
      /^alter\s+table\b/i.test(stmt) &&
      /\badd\s+(column\s+)?/i.test(stmt) &&
      /\bdefault\s+.*(random\(|clock_timestamp\(|gen_random_uuid\(|uuid_generate_v4\()/i.test(
        stmt
      )
    ) {
      findings.push({
        ruleId: 'PG-LOCK-004',
        severity: 'WARNING',
        title: 'Volatile Default Triggers Full Table Rewrite',
        plainEnglishImpact:
          'Using a volatile function like random() or gen_random_uuid() as a column default forces PostgreSQL to rewrite every existing row under an exclusive lock.',
        lockLevel: 'ACCESS EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'Add the column nullable without a default, set the default for new rows with ALTER COLUMN SET DEFAULT, and backfill old rows in small batches.',
      });
    }

    // 6. SET NOT NULL directly
    if (
      /^alter\s+table\b/i.test(stmt) &&
      /\bset\s+not\s+null\b/i.test(stmt)
    ) {
      findings.push({
        ruleId: 'PG-LOCK-005',
        severity: 'WARNING',
        title: 'Direct SET NOT NULL Scans Entire Table Under Exclusive Lock',
        plainEnglishImpact:
          'PostgreSQL must scan every row while holding an exclusive lock to confirm no NULLs exist, stalling traffic on large tables.',
        lockLevel: 'ACCESS EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'First add CHECK (col IS NOT NULL) NOT VALID, run VALIDATE CONSTRAINT (non-blocking), and then run SET NOT NULL (instant on PG 12+).',
      });
    }

    // 7. ADD FOREIGN KEY without NOT VALID
    if (
      /^alter\s+table\b/i.test(stmt) &&
      /\bforeign\s+key\b|\breferences\b/i.test(stmt) &&
      !/\bnot\s+valid\b/i.test(stmt)
    ) {
      findings.push({
        ruleId: 'PG-LOCK-006',
        severity: 'WARNING',
        title: 'Foreign Key Constraint Without NOT VALID',
        plainEnglishImpact:
          'Validating a new foreign key locks writes on both the child and parent tables while checking every existing row.',
        lockLevel: 'SHARE ROW EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'Append NOT VALID to the ADD CONSTRAINT statement, then run ALTER TABLE ... VALIDATE CONSTRAINT in a second step.',
        safeRewrite: `${stmt} NOT VALID;`,
      });
    }

    // 8. DROP TABLE or DROP COLUMN or TRUNCATE
    if (
      /^drop\s+table\b/i.test(stmt) ||
      /^truncate\b/i.test(stmt) ||
      (/\balter\s+table\b/i.test(stmt) && /\bdrop\s+(column\s+)?/i.test(stmt))
    ) {
      findings.push({
        ruleId: 'PG-DESTRUCT-001',
        severity: 'CRITICAL',
        title: 'Destructive Schema Operation (DROP / TRUNCATE)',
        plainEnglishImpact:
          'Irreversibly removes data or breaks running application pods that still reference the dropped table or column during a rolling deploy.',
        lockLevel: 'ACCESS EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'Deploy application code that stops reading/writing the column or table first, wait one release cycle, then drop in a follow-up migration.',
      });
    }

    // 9. RENAME TABLE or RENAME COLUMN
    if (/\brename\s+(to|column)\b/i.test(stmt)) {
      findings.push({
        ruleId: 'PG-COMPAT-001',
        severity: 'WARNING',
        title: 'In-Place Rename Breaks Zero-Downtime Rolling Deploys',
        plainEnglishImpact:
          'Old application instances still query the old name immediately after the rename runs, causing sudden 500 errors.',
        lockLevel: 'ACCESS EXCLUSIVE',
        statementPreview: preview,
        recommendation:
          'Add a new column/view alias, dual-write during transition, switch reads, then clean up the old name.',
      });
    }

    // 10. Unbounded UPDATE / DELETE without WHERE
    if (
      (/^(update|delete\s+from)\b/i.test(stmt) && !/\bwhere\b/i.test(stmt))
    ) {
      findings.push({
        ruleId: 'PG-DATA-002',
        severity: 'CRITICAL',
        title: 'Unbounded UPDATE or DELETE Without WHERE Clause',
        plainEnglishImpact:
          'Modifies or deletes every row in the table in one giant transaction, locking rows and creating massive table bloat.',
        lockLevel: 'ROW EXCLUSIVE (Full Table)',
        statementPreview: preview,
        recommendation:
          'Add an explicit WHERE filter or batch the backfill into chunks of 1,000–5,000 rows.',
      });
    }
  }

  // 11. Missing lock_timeout / statement_timeout safety guard
  if (statements.length > 0 && (!hasLockTimeout || !hasStatementTimeout)) {
    findings.push({
      ruleId: 'PG-GUARD-001',
      severity: 'INFO',
      title: 'Missing lock_timeout or statement_timeout Guard',
      plainEnglishImpact:
        'Without a lock timeout, a waiting DDL migration queues every incoming query behind it and can cause a cascading outage.',
      lockLevel: 'PREVENTIVE',
      statementPreview: 'Migration script header',
      recommendation:
        "Prefix migrations with SET lock_timeout = '5s'; and SET statement_timeout = '30s'; so blocked migrations fail fast instead of stalling production.",
    });
  }

  const hasCritical = findings.some((f) => f.severity === 'CRITICAL');
  const hasWarning = findings.some((f) => f.severity === 'WARNING');
  const riskLevel: 'SAFE' | 'WARNING' | 'BLOCKED' = hasCritical
    ? 'BLOCKED'
    : hasWarning
      ? 'WARNING'
      : 'SAFE';

  const guardPrefix =
    !hasLockTimeout || !hasStatementTimeout
      ? `-- DriftGuard Zero-Downtime Safety Guards\nSET lock_timeout = '5s';\nSET statement_timeout = '30s';\n\n`
      : '';

  const wrappedSafeSql = `${guardPrefix}${rawSql.trim()}\n`;

  return { riskLevel, findings, wrappedSafeSql };
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export function generateSyncSqlFromDiff(
  diffs: ColumnDiffItem[],
  sourceLabel: string,
  targetLabel: string
): string {
  if (!diffs.length) {
    return `-- ${sourceLabel} and ${targetLabel} schemas are identical.\n-- No DDL changes required.`;
  }

  const lines: string[] = [
    `-- DriftGuard Reconciliation Script`,
    `-- Aligns "${targetLabel}" to match "${sourceLabel}" (${diffs.length} column change${diffs.length === 1 ? '' : 's'})`,
    `SET lock_timeout = '5s';`,
    `SET statement_timeout = '30s';`,
    '',
  ];

  for (const diff of diffs) {
    const tableRef = `${quoteIdent(diff.table_schema)}.${quoteIdent(diff.table_name)}`;
    const colRef = quoteIdent(diff.column_name);

    // Note: diffCatalogs(baseline=target, live=source) ->
    // ADDED means present in source (live) and missing in target (baseline) -> ADD COLUMN
    // REMOVED means present in target (baseline) and missing in source (live) -> DROP COLUMN (commented for safety)
    // MODIFIED means present in both with different type/nullability/default
    if (diff.kind === 'ADDED' && diff.live) {
      const defaultClause = diff.live.column_default
        ? ` DEFAULT ${diff.live.column_default}`
        : '';
      const nullClause =
        diff.live.is_nullable === 'NO' && diff.live.column_default
          ? ' NOT NULL'
          : '';
      lines.push(
        `ALTER TABLE ${tableRef} ADD COLUMN IF NOT EXISTS ${colRef} ${diff.live.data_type}${defaultClause}${nullClause};`
      );
      if (diff.live.is_nullable === 'NO' && !diff.live.column_default) {
        lines.push(
          `-- Note: Column ${colRef} is NOT NULL in source without a default. Backfill before enforcing NOT NULL.`
        );
      }
    } else if (diff.kind === 'REMOVED') {
      lines.push(
        `-- Destructive change commented out for safety (verify no active app queries before running):`
      );
      lines.push(
        `-- ALTER TABLE ${tableRef} DROP COLUMN IF EXISTS ${colRef};`
      );
    } else if (diff.kind === 'MODIFIED' && diff.baseline && diff.live) {
      if (diff.baseline.data_type !== diff.live.data_type) {
        lines.push(
          `-- Warning: Type change (${diff.baseline.data_type} -> ${diff.live.data_type}) may acquire ACCESS EXCLUSIVE lock:`
        );
        lines.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} TYPE ${diff.live.data_type};`
        );
      }
      if (diff.baseline.is_nullable !== diff.live.is_nullable) {
        lines.push(
          diff.live.is_nullable === 'NO'
            ? `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} SET NOT NULL;`
            : `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} DROP NOT NULL;`
        );
      }
      if ((diff.baseline.column_default ?? '') !== (diff.live.column_default ?? '')) {
        lines.push(
          diff.live.column_default
            ? `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} SET DEFAULT ${diff.live.column_default};`
            : `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} DROP DEFAULT;`
        );
      }
    }
  }

  return lines.join('\n');
}
