import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ChevronDown, ChevronUp, Layers, RotateCcw } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext.tsx';
import { useI18n } from '../../i18n/LocaleContext.tsx';

export type Cluster3DPreset = 'overview' | 'exploded' | 'drift' | 'blockers';

interface HeroCluster3DProps {
  initialPreset?: Cluster3DPreset;
  heightClassName?: string;
}

interface SatelliteSpec {
  id: string;
  label: string;
  env: string;
  status: 'DRIFT' | 'HEALTHY' | 'WARNING' | 'ACTIVE';
  colorHex: number;
  position: [number, number, number];
  metric: string;
}

const SATELLITES: SatelliteSpec[] = [
  {
    id: 'prod-billing-pg',
    label: 'prod-billing-pg',
    env: 'Production',
    status: 'DRIFT',
    colorHex: 0xef4444,
    position: [3.15, 0.72, 1.45],
    metric: 'SHA-256 Drift · 2 Root Blockers',
  },
  {
    id: 'prod-core-ledger',
    label: 'prod-core-ledger',
    env: 'Production',
    status: 'HEALTHY',
    colorHex: 0x10b981,
    position: [-3.1, 0.95, 1.35],
    metric: '100/100 Health · 99.4% Cache Hit',
  },
  {
    id: 'staging-orders-pg',
    label: 'staging-orders-pg',
    env: 'Staging',
    status: 'WARNING',
    colorHex: 0xf59e0b,
    position: [-2.65, -0.45, -2.55],
    metric: 'Lock Wait 46s · Auto-Inspect On',
  },
  {
    id: 'dev-analytics-pg',
    label: 'dev-analytics-pg',
    env: 'Development',
    status: 'ACTIVE',
    colorHex: 0x3b82f6,
    position: [2.7, -0.3, -2.45],
    metric: '722 tx/s · pg_stat_activity Live',
  },
];

// Reusable math helpers outside animation loop (zero GC per frame)
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _dummy = new THREE.Object3D();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createRadialContactTexture(isDark: boolean): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      12,
      size / 2,
      size / 2,
      size / 2
    );
    if (isDark) {
      g.addColorStop(0, 'rgba(37, 99, 235, 0.34)');
      g.addColorStop(0.45, 'rgba(15, 23, 42, 0.42)');
      g.addColorStop(1, 'rgba(2, 6, 23, 0)');
    } else {
      g.addColorStop(0, 'rgba(37, 99, 235, 0.18)');
      g.addColorStop(0.5, 'rgba(15, 23, 42, 0.14)');
      g.addColorStop(1, 'rgba(241, 245, 249, 0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createDeckGridTexture(isDark: boolean): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const stroke = isDark
      ? 'rgba(148, 163, 184, 0.22)'
      : 'rgba(51, 65, 85, 0.18)';
    const accent = isDark
      ? 'rgba(59, 130, 246, 0.38)'
      : 'rgba(29, 78, 216, 0.26)';

    // Concentric radar rings
    [76, 136, 198, 246].forEach((r, idx) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = idx === 2 ? accent : stroke;
      ctx.lineWidth = idx === 2 ? 1.8 : 1.1;
      if (idx === 1) ctx.setLineDash([6, 8]);
      else ctx.setLineDash([]);
      ctx.stroke();
    });

    // Radial tick spokes
    ctx.setLineDash([]);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const inner = i % 3 === 0 ? 76 : 198;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * 246, cy + Math.sin(a) * 246);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = i % 3 === 0 ? 1.2 : 0.7;
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function HeroCluster3D({
  initialPreset = 'overview',
  heightClassName = 'h-[430px] sm:h-[490px] lg:h-[540px]',
}: HeroCluster3DProps) {
  const { isDark } = useTheme();
  const { tr } = useI18n();

  const mountRef = useRef<HTMLDivElement | null>(null);
  const [preset, setPreset] = useState<Cluster3DPreset>(initialPreset);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('prod-billing-pg');
  const [dockOpen, setDockOpen] = useState(true);
  const [webglError, setWebglError] = useState(false);

  const presetRef = useRef<Cluster3DPreset>(initialPreset);
  const isDarkRef = useRef<boolean>(isDark);
  const syncThemeRef = useRef<((dark: boolean) => void) | null>(null);
  const transitionActiveRef = useRef<boolean>(true);
  const cameraGoalRef = useRef(new THREE.Vector3(0.4, 2.55, 7.35));
  const targetGoalRef = useRef(new THREE.Vector3(0, 0.1, 0));

  useEffect(() => {
    presetRef.current = preset;
    transitionActiveRef.current = true;
    if (preset === 'overview') {
      cameraGoalRef.current.set(0.4, 2.55, 7.35);
      targetGoalRef.current.set(0, 0.1, 0);
    } else if (preset === 'exploded') {
      cameraGoalRef.current.set(3.4, 2.15, 6.4);
      targetGoalRef.current.set(0, 0.25, 0);
    } else if (preset === 'drift') {
      cameraGoalRef.current.set(5.35, 1.85, 3.65);
      targetGoalRef.current.set(2.45, 0.55, 1.05);
      setSelectedNodeId('prod-billing-pg');
    } else if (preset === 'blockers') {
      cameraGoalRef.current.set(0, 6.7, 3.9);
      targetGoalRef.current.set(0, 0, 0);
    }
  }, [preset]);

  useEffect(() => {
    isDarkRef.current = isDark;
    syncThemeRef.current?.(isDark);
  }, [isDark]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
        alpha: false,
      });
    } catch {
      setWebglError(true);
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const bgHex = isDarkRef.current ? 0x020617 : 0xf1f5f9;
    scene.background = new THREE.Color(bgHex);
    scene.fog = new THREE.FogExp2(bgHex, 0.042);

    // Mandatory studio environment map for crisp metallic PBR reflections
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 80);
    camera.position.copy(cameraGoalRef.current);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 4.2;
    controls.maxDistance = 12.5;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.copy(targetGoalRef.current);
    controls.addEventListener('start', () => {
      transitionActiveRef.current = false;
    });

    // Balanced 3-point studio lighting rig (warm key + cool hemisphere + cobalt rim)
    const hemiLight = new THREE.HemisphereLight(0x93c5fd, 0x0f172a, 0.9);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.2);
    keyLight.position.set(6, 9, 6);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 26;
      const d = 6.5;
      keyLight.shadow.camera.left = -d;
      keyLight.shadow.camera.right = d;
      keyLight.shadow.camera.top = d;
      keyLight.shadow.camera.bottom = -d;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.35);
    rimLight.position.set(-6, 4, -5);
    scene.add(rimLight);

    // Track disposable resources
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];

    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      geometries.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      materials.push(m);
      return m;
    };

    // Shared PBR materials with distinct roughness/metalness contrast
    const brushedTitaniumMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x334155,
        metalness: 0.9,
        roughness: 0.24,
        clearcoat: 0.35,
      })
    );
    const darkAnodizedMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        metalness: 0.55,
        roughness: 0.52,
      })
    );
    const silverTrimMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xcbd5e1,
        metalness: 0.94,
        roughness: 0.16,
      })
    );
    const cobaltCoreMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x2563eb,
        emissive: 0x1d4ed8,
        emissiveIntensity: 0.55,
        metalness: 0.2,
        roughness: 0.14,
        clearcoat: 1.0,
        transparent: true,
        opacity: isSoftwareGl ? 0.65 : 0.82,
      })
    );
    const emeraldPlatterMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x10b981,
        emissive: 0x059669,
        emissiveIntensity: 0.38,
        metalness: 0.35,
        roughness: 0.2,
        transparent: true,
        opacity: 0.85,
      })
    );
    const amberPlatterMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xf59e0b,
        emissive: 0xd97706,
        emissiveIntensity: 0.35,
        metalness: 0.4,
        roughness: 0.22,
        transparent: true,
        opacity: 0.85,
      })
    );

    // 1. Grounded Architectural Telemetry Deck + Soft Contact Shadow
    const deckGroup = new THREE.Group();
    deckGroup.position.y = -1.78;
    scene.add(deckGroup);

    let contactTex = createRadialContactTexture(isDarkRef.current);
    const contactMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: contactTex,
        transparent: true,
        depthWrite: false,
      })
    );
    const contactPlane = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(9.6, 9.6)),
      contactMat
    );
    contactPlane.rotation.x = -Math.PI / 2;
    contactPlane.position.y = 0;
    deckGroup.add(contactPlane);

    let deckTex = createDeckGridTexture(isDarkRef.current);
    deckTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const deckMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: deckTex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );
    const deckDisc = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(8.8, 8.8)),
      deckMat
    );
    deckDisc.rotation.x = -Math.PI / 2;
    deckDisc.position.y = 0.03;
    deckGroup.add(deckDisc);

    // 2. Central Composite Primary PostgreSQL Engine Core (12+ part THREE.Group)
    const coreAssembly = new THREE.Group();
    scene.add(coreAssembly);

    // Base pedestal cap
    const baseCap = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(1.18, 1.32, 0.26, 36)),
      brushedTitaniumMat
    );
    baseCap.position.y = -0.95;
    baseCap.castShadow = !isSoftwareGl;
    baseCap.receiveShadow = !isSoftwareGl;
    coreAssembly.add(baseCap);

    const baseTrim = new THREE.Mesh(
      trackGeo(new THREE.TorusGeometry(1.25, 0.042, 16, 48)),
      silverTrimMat
    );
    baseTrim.rotation.x = Math.PI / 2;
    baseTrim.position.y = -0.84;
    coreAssembly.add(baseTrim);

    // Top crown cap
    const topCap = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(1.06, 1.2, 0.24, 36)),
      brushedTitaniumMat
    );
    topCap.position.y = 1.02;
    topCap.castShadow = !isSoftwareGl;
    coreAssembly.add(topCap);

    const topBeacon = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.46, 0.56, 0.14, 24)),
      cobaltCoreMat
    );
    topBeacon.position.y = 1.2;
    coreAssembly.add(topBeacon);

    // Inner glowing data spine
    const spine = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.36, 0.36, 1.92, 24)),
      cobaltCoreMat
    );
    spine.position.y = 0.04;
    coreAssembly.add(spine);

    // 6 structural titanium locking struts
    const strutGeo = trackGeo(new THREE.CylinderGeometry(0.04, 0.04, 1.96, 12));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const strut = new THREE.Mesh(strutGeo, darkAnodizedMat);
      strut.position.set(Math.cos(a) * 1.08, 0.04, Math.sin(a) * 1.08);
      coreAssembly.add(strut);
    }

    // 3 Composite Schema Platter Layers (explode smoothly along Y in Exploded Mode!)
    const platterBaseY = [-0.46, 0.04, 0.54];
    const platterExplodeOffsets = [-0.62, 0, 0.68];
    const platterMats = [amberPlatterMat, cobaltCoreMat, emeraldPlatterMat];
    const platters: THREE.Group[] = [];

    platterBaseY.forEach((baseY, idx) => {
      const layerGroup = new THREE.Group();
      layerGroup.position.y = baseY;

      const disc = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(1.12, 1.12, 0.16, 40)),
        platterMats[idx]
      );
      disc.castShadow = !isSoftwareGl;
      layerGroup.add(disc);

      const rim = new THREE.Mesh(
        trackGeo(new THREE.TorusGeometry(1.14, 0.032, 14, 48)),
        silverTrimMat
      );
      rim.rotation.x = Math.PI / 2;
      layerGroup.add(rim);

      // Machined hub ring
      const hub = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.5, 0.5, 0.2, 24)),
        darkAnodizedMat
      );
      layerGroup.add(hub);

      coreAssembly.add(layerGroup);
      platters.push(layerGroup);
    });

    // Twin Gyroscopic SHA-256 Verification Orbital Rings
    const gyroRingOuter = new THREE.Mesh(
      trackGeo(new THREE.TorusGeometry(1.78, 0.026, 14, 72)),
      silverTrimMat
    );
    gyroRingOuter.rotation.set(Math.PI * 0.36, 0.2, 0);
    coreAssembly.add(gyroRingOuter);

    const gyroRingInner = new THREE.Mesh(
      trackGeo(new THREE.TorusGeometry(1.54, 0.022, 14, 72)),
      cobaltCoreMat
    );
    gyroRingInner.rotation.set(-Math.PI * 0.32, 0.5, 0.3);
    coreAssembly.add(gyroRingInner);

    // 3. Four Composite Orbiting PostgreSQL Cluster Satellite Pods + Curved Fiber Conduits
    const satelliteGroups: {
      spec: SatelliteSpec;
      group: THREE.Group;
      beacon: THREE.Mesh;
      basePos: THREE.Vector3;
      phase: number;
    }[] = [];

    const clickableProxies: THREE.Mesh[] = [];
    const conduitCurves: THREE.QuadraticBezierCurve3[] = [];

    SATELLITES.forEach((spec, idx) => {
      const satGroup = new THREE.Group();
      const basePos = new THREE.Vector3(...spec.position);
      satGroup.position.copy(basePos);

      const accentMat = trackMat(
        new THREE.MeshPhysicalMaterial({
          color: spec.colorHex,
          emissive: spec.colorHex,
          emissiveIntensity: 0.65,
          metalness: 0.25,
          roughness: 0.18,
        })
      );

      // Part 1: Hexagonal armored chassis
      const body = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.42, 0.48, 0.52, 6)),
        brushedTitaniumMat
      );
      body.castShadow = !isSoftwareGl;
      satGroup.add(body);

      // Part 2: Mid cooling collar
      const collar = new THREE.Mesh(
        trackGeo(new THREE.TorusGeometry(0.45, 0.036, 12, 24)),
        silverTrimMat
      );
      collar.rotation.x = Math.PI / 2;
      satGroup.add(collar);

      // Part 3: Status beacon crown
      const beacon = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.24, 0.3, 0.14, 18)),
        accentMat
      );
      beacon.position.y = 0.33;
      satGroup.add(beacon);

      // Part 4: Lower telemetry receiver fin
      const fin = new THREE.Mesh(
        trackGeo(new THREE.ConeGeometry(0.22, 0.26, 6)),
        darkAnodizedMat
      );
      fin.rotation.x = Math.PI;
      fin.position.y = -0.39;
      satGroup.add(fin);

      // Layer-1 invisible raycast proxy for effortless click selection
      const proxy = new THREE.Mesh(
        trackGeo(new THREE.SphereGeometry(0.7, 10, 10)),
        trackMat(new THREE.MeshBasicMaterial({ visible: false }))
      );
      proxy.layers.set(1);
      proxy.userData.satelliteId = spec.id;
      proxy.userData.satellitePos = basePos;
      satGroup.add(proxy);
      clickableProxies.push(proxy);

      scene.add(satGroup);
      satelliteGroups.push({
        spec,
        group: satGroup,
        beacon,
        basePos,
        phase: idx * 1.55,
      });

      // Curved 3D telemetry conduit from core to satellite
      const midPoint = new THREE.Vector3(
        basePos.x * 0.5,
        Math.max(basePos.y, 0.15) + 0.85,
        basePos.z * 0.5
      );
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(basePos.x * 0.28, 0.1, basePos.z * 0.28),
        midPoint,
        basePos.clone()
      );
      conduitCurves.push(curve);

      const tubeMat = trackMat(
        new THREE.MeshStandardMaterial({
          color: spec.colorHex,
          emissive: spec.colorHex,
          emissiveIntensity: 0.25,
          metalness: 0.4,
          roughness: 0.35,
          transparent: true,
          opacity: 0.5,
        })
      );
      const tubeMesh = new THREE.Mesh(
        trackGeo(new THREE.TubeGeometry(curve, 28, 0.022, 8, false)),
        tubeMat
      );
      scene.add(tubeMesh);
    });

    // 4. High-Speed Animated Streaming Data Packets (InstancedMesh - 64 instances)
    const PACKET_COUNT = 64;
    const packetGeo = trackGeo(new THREE.OctahedronGeometry(0.068, 0));
    const packetMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.85,
        roughness: 0.2,
        metalness: 0.3,
      })
    );
    const packetMesh = new THREE.InstancedMesh(packetGeo, packetMat, PACKET_COUNT);
    packetMesh.frustumCulled = false;

    const packetColors = [
      new THREE.Color(0xef4444),
      new THREE.Color(0x10b981),
      new THREE.Color(0xf59e0b),
      new THREE.Color(0x38bdf8),
    ];
    for (let i = 0; i < PACKET_COUNT; i++) {
      packetMesh.setColorAt(i, packetColors[i % 4]);
    }
    if (packetMesh.instanceColor) packetMesh.instanceColor.needsUpdate = true;
    scene.add(packetMesh);

    // 5. Subtle Star/Node Telemetry Field (InstancedMesh - 48 background micro-nodes)
    const NODE_COUNT = 48;
    const microGeo = trackGeo(new THREE.BoxGeometry(0.05, 0.05, 0.05));
    const microMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x60a5fa,
        emissive: 0x2563eb,
        emissiveIntensity: 0.4,
        roughness: 0.4,
        metalness: 0.6,
      })
    );
    const microField = new THREE.InstancedMesh(microGeo, microMat, NODE_COUNT);
    microField.frustumCulled = false;
    const microSeeds: { r: number; a: number; y: number; speed: number }[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      const r = 3.8 + (i % 7) * 0.55;
      const a = (i / NODE_COUNT) * Math.PI * 2;
      const y = ((i % 9) - 4) * 0.42;
      microSeeds.push({ r, a, y, speed: 0.08 + (i % 5) * 0.025 });
      _dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      _dummy.scale.setScalar(0.85 + (i % 3) * 0.25);
      _dummy.updateMatrix();
      microField.setMatrixAt(i, _dummy.matrix);
    }
    microField.instanceMatrix.needsUpdate = true;
    scene.add(microField);

    // Raycaster restricted strictly to layer 1 proxy spheres
    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(1);
    const pointerNdc = new THREE.Vector2();
    const pointerParallax = { x: 0, y: 0 };

    const onPointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      pointerParallax.x = THREE.MathUtils.clamp(nx, -1, 1);
      pointerParallax.y = THREE.MathUtils.clamp(ny, -1, 1);
    };

    const onClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObjects(clickableProxies, false);
      if (hits.length > 0) {
        const hitId = String(hits[0].object.userData.satelliteId ?? '');
        const hitPos = hits[0].object.userData.satellitePos as
          | THREE.Vector3
          | undefined;
        if (hitId && hitPos) {
          setSelectedNodeId(hitId);
          targetGoalRef.current.copy(hitPos).multiplyScalar(0.75);
          cameraGoalRef.current.set(
            hitPos.x * 1.45 + 1.4,
            hitPos.y + 1.5,
            hitPos.z * 1.45 + 2.8
          );
          transitionActiveRef.current = true;
        }
      }
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove, {
      passive: true,
    });
    renderer.domElement.addEventListener('click', onClick);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      setWebglError(true);
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // ResizeObserver for crisp responsive fitting
    const ro = new ResizeObserver(() => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    ro.observe(container);

    // Smooth animation loop with software-WebGL afterDraw pacing
    const clock = new THREE.Clock();
    let frameId = 0;
    let disposed = false;
    let explodeFactor = initialPreset === 'exploded' ? 1 : 0;
    let lastDark = isDarkRef.current;

    function applySceneTheme(dark: boolean) {
      if (disposed) return;
      const nextBg = dark ? 0x020617 : 0xf1f5f9;
      scene.background = new THREE.Color(nextBg);
      scene.fog = new THREE.FogExp2(nextBg, 0.042);

      const nextContact = createRadialContactTexture(dark);
      contactMat.map = nextContact;
      contactMat.needsUpdate = true;
      contactTex.dispose();
      contactTex = nextContact;

      const nextDeck = createDeckGridTexture(dark);
      nextDeck.anisotropy = renderer.capabilities.getMaxAnisotropy();
      deckMat.map = nextDeck;
      deckMat.needsUpdate = true;
      deckTex.dispose();
      deckTex = nextDeck;

      renderer.render(scene, camera);
    }

    syncThemeRef.current = applySceneTheme;

    function afterDraw(cb: () => void) {
      if (disposed) return;
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        let polls = 0;
        const poll = () => {
          if (disposed) {
            if (sync) gl.deleteSync(sync);
            return;
          }
          polls += 1;
          const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
          if (state === gl.UNSIGNALED && polls < 25) {
            frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            frameId = window.setTimeout(cb, 80);
          }
        };
        frameId = window.setTimeout(poll, 5);
      } else {
        frameId = window.setTimeout(cb, 80);
      }
    }

    function tick() {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.getElapsedTime();

      // Sync theme background smoothly if user toggles Light/Dark mode
      if (lastDark !== isDarkRef.current) {
        lastDark = isDarkRef.current;
        applySceneTheme(lastDark);
      }

      // Smoothly damp exploded layers
      const explodeTarget = presetRef.current === 'exploded' ? 1 : 0;
      explodeFactor = THREE.MathUtils.damp(explodeFactor, explodeTarget, 5.5, dt);

      platters.forEach((p, idx) => {
        p.position.y =
          platterBaseY[idx] +
          platterExplodeOffsets[idx] * explodeFactor +
          Math.sin(t * 1.4 + idx) * 0.025;
        p.rotation.y = t * (0.28 + idx * 0.12) * (idx % 2 === 0 ? 1 : -1);
      });
      topCap.position.y = 1.02 + explodeFactor * 0.72;
      topBeacon.position.y = 1.2 + explodeFactor * 0.72;
      baseCap.position.y = -0.95 - explodeFactor * 0.52;
      baseTrim.position.y = -0.84 - explodeFactor * 0.52;

      // Rotate verification gyro rings & subtle core float
      coreAssembly.position.y = Math.sin(t * 0.9) * 0.08;
      coreAssembly.rotation.y =
        t * 0.14 + THREE.MathUtils.damp(0, pointerParallax.x * 0.18, 4, dt);
      gyroRingOuter.rotation.z = t * 0.42;
      gyroRingInner.rotation.x = -Math.PI * 0.32 + Math.sin(t * 0.5) * 0.15;
      gyroRingInner.rotation.z = -t * 0.55;

      // Animate orbiting cluster satellites
      for (const sat of satelliteGroups) {
        sat.group.position.y = sat.basePos.y + Math.sin(t * 1.35 + sat.phase) * 0.14;
        sat.group.rotation.y = t * 0.45 + sat.phase;
      }

      // Update streaming telemetry data packets along 3D curves (zero GC)
      for (let i = 0; i < PACKET_COUNT; i++) {
        const curveIdx = i % conduitCurves.length;
        const curve = conduitCurves[curveIdx];
        const laneOffset = Math.floor(i / conduitCurves.length) / (PACKET_COUNT / 4);
        const speed = curveIdx === 0 ? 0.52 : 0.36;
        const u = (t * speed + laneOffset) % 1;
        curve.getPoint(u, _vA);
        curve.getTangent(u, _vB);
        _dummy.position.copy(_vA);
        _dummy.lookAt(_vA.x + _vB.x, _vA.y + _vB.y, _vA.z + _vB.z);
        const s = 0.75 + Math.sin(u * Math.PI) * 0.55;
        _dummy.scale.setScalar(s);
        _dummy.updateMatrix();
        packetMesh.setMatrixAt(i, _dummy.matrix);
      }
      packetMesh.instanceMatrix.needsUpdate = true;

      // Slowly drift ambient micro-nodes
      for (let i = 0; i < NODE_COUNT; i++) {
        const seed = microSeeds[i];
        const a = seed.a + t * seed.speed;
        _dummy.position.set(
          Math.cos(a) * seed.r,
          seed.y + Math.sin(t * 0.7 + i) * 0.12,
          Math.sin(a) * seed.r
        );
        _dummy.rotation.set(t * 0.5, a, 0);
        _dummy.scale.setScalar(0.85);
        _dummy.updateMatrix();
        microField.setMatrixAt(i, _dummy.matrix);
      }
      microField.instanceMatrix.needsUpdate = true;

      // Smooth damped camera preset transitions (canceled when user orbits manually)
      if (transitionActiveRef.current) {
        camera.position.x = THREE.MathUtils.damp(
          camera.position.x,
          cameraGoalRef.current.x + pointerParallax.x * 0.35,
          4.5,
          dt
        );
        camera.position.y = THREE.MathUtils.damp(
          camera.position.y,
          cameraGoalRef.current.y + pointerParallax.y * 0.2,
          4.5,
          dt
        );
        camera.position.z = THREE.MathUtils.damp(
          camera.position.z,
          cameraGoalRef.current.z,
          4.5,
          dt
        );
        controls.target.x = THREE.MathUtils.damp(
          controls.target.x,
          targetGoalRef.current.x,
          5.0,
          dt
        );
        controls.target.y = THREE.MathUtils.damp(
          controls.target.y,
          targetGoalRef.current.y,
          5.0,
          dt
        );
        controls.target.z = THREE.MathUtils.damp(
          controls.target.z,
          targetGoalRef.current.z,
          5.0,
          dt
        );
      }

      controls.update();
      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = window.requestAnimationFrame(tick);
      }
    }

    tick();

    return () => {
      disposed = true;
      syncThemeRef.current = null;
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(frameId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      envRT.dispose();
      contactTex.dispose();
      deckTex.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((tex) => tex.dispose());
      renderer.dispose();
    };
  }, [initialPreset]);

  const activeSat =
    SATELLITES.find((s) => s.id === selectedNodeId) ?? SATELLITES[0];

  if (webglError) {
    return (
      <div
        className={`relative w-full ${heightClassName} rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900`}
      >
        <img
          src="/screenshots/blocker-tree-dark.png"
          alt="DriftGuard 3D PostgreSQL Telemetry Fallback"
          className="w-full h-full object-cover object-top"
        />
      </div>
    );
  }

  return (
    <div
      className={`relative w-full ${heightClassName} rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 select-none`}
    >
      {/* Isolated WebGL Canvas Container */}
      <div ref={mountRef} className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing" />

      {/* Minimal Top-Left Node Spec Readout (no backdrop-filter over WebGL!) */}
      <div className="pointer-events-none absolute top-3.5 left-3.5 z-10 max-w-[80%]">
        <div className="px-3 py-1.5 rounded-lg bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 text-xs">
          <div className="flex items-center gap-2 font-mono">
            <span
              className={`font-semibold ${
                activeSat.status === 'DRIFT'
                  ? 'text-red-600 dark:text-red-400'
                  : activeSat.status === 'WARNING'
                    ? 'text-amber-600 dark:text-amber-400'
                    : activeSat.status === 'HEALTHY'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-blue-600 dark:text-blue-400'
              }`}
            >
              {activeSat.status}
            </span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {activeSat.label}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5 truncate">
            {activeSat.metric}
          </p>
        </div>
      </div>

      {/* Collapsible Unified Bottom Control Dock (zero viewport center occlusion) */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center max-w-[94%]">
        <button
          type="button"
          onClick={() => setDockOpen((v) => !v)}
          className="mb-1 px-2.5 py-0.5 rounded-md bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-1 cursor-pointer"
        >
          {dockOpen ? (
            <>
              <ChevronDown className="w-3 h-3" />
              <span>{tr('Hide 3D Controls', '3D ထိန်းချုပ်မှု ဖုံးရန်')}</span>
            </>
          ) : (
            <>
              <ChevronUp className="w-3 h-3" />
              <span>{tr('3D Controls', '3D ထိန်းချုပ်မှု')}</span>
            </>
          )}
        </button>

        {dockOpen && (
          <div className="flex flex-nowrap items-center justify-center gap-1 p-1 rounded-xl bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 shadow-sm overflow-x-auto max-w-full">
            {(
              [
                { id: 'overview', label: tr('Orbit', 'လှည့်ပတ်') },
                { id: 'exploded', label: tr('Exploded', 'အလွှာခွဲ') },
                { id: 'drift', label: tr('Drift Node', 'Drift') },
                { id: 'blockers', label: tr('Top Mesh', 'အပေါ်') },
              ] as { id: Cluster3DPreset; label: string }[]
            ).map((btn) => (
              <button
                key={btn.id}
                type="button"
                onClick={() => setPreset(btn.id)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1 ${
                  preset === btn.id
                    ? 'bg-blue-700 dark:bg-blue-600 text-white'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {btn.id === 'exploded' && <Layers className="w-3 h-3" />}
                <span>{btn.label}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setPreset('overview');
                setSelectedNodeId('prod-billing-pg');
                transitionActiveRef.current = true;
              }}
              aria-label={tr('Reset 3D camera', '3D ကင်မရာ ပြန်ညှိရန်')}
              className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
