import React, { useEffect, useRef } from 'react';

interface HypotrochoidCanvasProps {
  size?: number; // 画布宽高像素
  R?: number;    // 外圆半径
  r?: number;    // 内圆半径
  d?: number;    // 追踪点到内圆圆心的距离
  color?: string; // 粒子颜色
}

/**
 * 极具东方神兽“谛听”深邃科技感的【内摆线 (Hypotrochoid) 粒子轨迹方程动画】
 * 内摆线参数方程：
 * x(t) = (R - r) * cos(t) + d * cos((R - r) * t / r)
 * y(t) = (R - r) * sin(t) - d * sin((R - r) * t / r)
 */
export const HypotrochoidCanvas: React.FC<HypotrochoidCanvasProps> = ({
  size = 180,
  R = 75,
  r = 45,
  d = 50,
  color = '#38bdf8',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let t = 0;
    const points: { x: number; y: number; alpha: number }[] = [];

    const centerX = size / 2;
    const centerY = size / 2;

    const render = () => {
      // 尾迹拖尾效果
      ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
      ctx.fillRect(0, 0, size, size);

      // 计算当前内摆线轨迹点
      const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) * t) / r);
      const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) * t) / r);

      points.push({ x: centerX + x, y: centerY + y, alpha: 1.0 });

      if (points.length > 220) {
        points.shift();
      }

      // 绘制内摆线粒子轨迹线段
      ctx.lineWidth = 2;
      for (let i = 1; i < points.length; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        const progress = i / points.length;

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);

        // 动态青蓝-紫金色渐变
        const strokeColor =
          progress > 0.8
            ? '#f59e0b'
            : progress > 0.5
            ? '#06b6d4'
            : '#3b82f6';

        ctx.strokeStyle = strokeColor;
        ctx.globalAlpha = progress;
        ctx.stroke();
      }

      // 绘制龙头粒子头部亮光
      const head = points[points.length - 1];
      if (head) {
        ctx.globalAlpha = 1.0;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fbbf24';
        ctx.shadowColor = '#06b6d4';
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      t += 0.04;
      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [size, R, r, d, color]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="rounded-full shadow-[0_0_40px_rgba(6,182,212,0.35)]"
    />
  );
};
