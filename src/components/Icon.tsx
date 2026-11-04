import type { SVGProps } from 'react';
import type { JSX } from 'react';

/**
 * One icon system: 24px grid, 1.5px stroke, square caps, currentColor.
 * Glyphs are drawn, never substituted with emoji.
 */
const glyphs = {
  aperture: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3l6.5 11M12 3L5.5 14M3.2 9.5h17.6" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
    </>
  ),
  sliders: (
    <>
      <path d="M3.5 8h9M17.5 8h3M3.5 16h3M11.5 16h9" />
      <circle cx="15" cy="8" r="2.25" />
      <circle cx="9" cy="16" r="2.25" />
    </>
  ),
  crop: (
    <>
      <path d="M6.5 3v14.5A1.5 1.5 0 0 0 8 19h14" />
      <path d="M17.5 21V6.5A1.5 1.5 0 0 0 16 5H5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11.5" />
      <path d="m7.5 11 4.5 4.5 4.5-4.5" />
      <path d="M4 20h16" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m4 17.5 4.5-4.5 3.5 3.5 3-2.5 5 5" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M20 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2 7 7M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8" />
    </>
  ),
  moon: <path d="M20.5 14.8A8.5 8.5 0 0 1 9.2 3.5a8.5 8.5 0 1 0 11.3 11.3Z" />,
  portrait: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20.5a7 7 0 0 1 14 0" />
    </>
  ),
  building: (
    <>
      <rect x="4" y="9.5" width="7" height="11" />
      <rect x="13" y="3.5" width="7" height="17" />
      <path d="M6.5 13h2M6.5 16.5h2M15.5 7h2M15.5 10.5h2M15.5 14h2M15.5 17.5h2" />
    </>
  ),
  contrast: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 8.5 4.8-8.5 4.8L3.5 7.8 12 3Z" />
      <path d="m3.5 13.2 8.5 4.8 8.5-4.8" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.5 2.1" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  undo: (
    <>
      <path d="M8 5 3.5 9.5 8 14" />
      <path d="M3.5 9.5H14a5.5 5.5 0 0 1 0 11h-4.5" />
    </>
  ),
  redo: (
    <>
      <path d="m16 5 4.5 4.5L16 14" />
      <path d="M20.5 9.5H10a5.5 5.5 0 0 0 0 11h4.5" />
    </>
  ),
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  star: (
    <path d="m12 3.8 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 10l5.9-.9Z" />
  ),
  folder: (
    <>
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
    </>
  ),
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof glyphs;

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
  label?: string;
};

export function Icon({ name, size = 20, label, ...rest }: IconProps) {
  const decorative = !label;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden={decorative || undefined}
      aria-label={label}
      role={decorative ? undefined : 'img'}
      focusable="false"
      {...rest}
    >
      {glyphs[name]}
    </svg>
  );
}
