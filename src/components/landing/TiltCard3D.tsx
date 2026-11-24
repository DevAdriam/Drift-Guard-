import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface TiltCard3DProps {
  children: ReactNode;
  className?: string;
  maxTiltDeg?: number;
  onClick?: () => void;
}

export function TiltCard3D({
  children,
  className = '',
  maxTiltDeg = 7,
  onClick,
}: TiltCard3DProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState(
    'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)'
  );
  const [glare, setGlare] = useState({ x: 50, y: 50, opacity: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rotY = (px - 0.5) * maxTiltDeg * 2;
    const rotX = (0.5 - py) * maxTiltDeg * 2;

    setTransform(
      `perspective(1000px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(
        2
      )}deg) scale3d(1.015, 1.015, 1.015)`
    );
    setGlare({ x: px * 100, y: py * 100, opacity: 1 });
  };

  const handleMouseLeave = () => {
    setTransform(
      'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)'
    );
    setGlare((prev) => ({ ...prev, opacity: 0 }));
  };

  return (
    <div
      ref={cardRef}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        transform,
        transformStyle: 'preserve-3d',
        transition:
          glare.opacity > 0
            ? 'transform 90ms ease-out'
            : 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      className={`relative will-change-transform ${className}`}
    >
      {children}
      <div
        aria-hidden="true"
        style={{
          opacity: glare.opacity,
          background: `radial-gradient(circle 280px at ${glare.x}% ${glare.y}%, rgba(59,130,246,0.14), transparent 72%)`,
          transition: 'opacity 220ms ease-out',
        }}
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
      />
    </div>
  );
}
