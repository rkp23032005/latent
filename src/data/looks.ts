import type { IconName } from '../components/Icon';

/**
 * The homepage's category cards: names, one-line positions and a sample
 * photograph each. These are illustrations of a family of looks, not evidence of
 * one — the presets the editor actually offers live in `public/presets/library.json`,
 * built by `npm run presets:update` and painted by the engine on request.
 */
export type Look = {
  no: string;
  name: string;
  blurb: string;
  image: string;
  icon: IconName;
};

export const looks: Look[] = [
  {
    no: '01',
    name: 'Portrait',
    blurb: 'Skin kept soft, eyes left open, no plastic shine.',
    image: '/photography/portrait-studio.jpg',
    icon: 'portrait',
  },
  {
    no: '02',
    name: 'Daylight',
    blurb: 'Warm midtones with the sky held back from blowing out.',
    image: '/photography/golden-hour.jpg',
    icon: 'sun',
  },
  {
    no: '03',
    name: 'Street',
    blurb: 'Denser blacks, colour pulled a half step towards grey.',
    image: '/photography/street-alley.jpg',
    icon: 'building',
  },
  {
    no: '04',
    name: 'Night',
    blurb: 'Lifted shadows that keep the grain instead of the noise.',
    image: '/photography/night-concert.jpg',
    icon: 'moon',
  },
  {
    no: '05',
    name: 'Monochrome',
    blurb: 'Full tonal range, no muddy middle, silver in the highlights.',
    image: '/photography/mono-beach.jpg',
    icon: 'contrast',
  },
  {
    no: '06',
    name: 'Landscape',
    blurb: 'Depth kept wide, greens and rocks separated rather than fused.',
    image: '/photography/landscape-highlands.jpg',
    icon: 'layers',
  },
];

/** Frames used to introduce the three moves of the workflow. */
export const workflowFrames = [
  { image: '/photography/urban-aerial.jpg', label: 'Load' },
  { image: '/photography/clouds-ridge.jpg', label: 'Choose' },
  { image: '/photography/stilllife-hands.jpg', label: 'Export' },
];

