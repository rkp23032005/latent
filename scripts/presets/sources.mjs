/**
 * Registry of upstream preset sources for the automated library build.
 *
 * Two rules govern this list, and both are about honesty rather than volume:
 *
 *   1. We only accept a licence we can spell out and stand behind — MIT, CC0,
 *      CC BY 4.0, Apache 2.0, BSD-3 or Unlicense. Share-alike (CC BY-SA) and
 *      copyleft (GPL/AGPL) licences would have to be honoured by re-licensing
 *      the whole derived preset table, so those sources are recorded and left
 *      alone rather than quietly mixed in.
 *   2. A rejected source is still reported. Silence about what we skipped would
 *      look like we never looked, and the reason string is the audit trail.
 *
 * Accepted entries carry the full record; rejected entries carry only enough to
 * explain why they were not used. `priority` is a small integer — the importer
 * walks sources in ascending order, so on a duplicate the lower number wins.
 */

/** The only SPDX ids this project is willing to import from. */
export const ACCEPTED_SPDX = Object.freeze([
  'MIT',
  'CC0-1.0',
  'CC-BY-4.0',
  'Apache-2.0',
  'BSD-3-Clause',
  'Unlicense',
]);

/**
 * A licence id can only be accepted if it is on the list above. Share-alike and
 * copyleft ids fall through here and are reported as rejected even if a source
 * were otherwise well-behaved.
 */
export function isLicenceAcceptable(licence) {
  return ACCEPTED_SPDX.includes(licence);
}

/**
 * Sources we are willing to download, verify and import.
 *
 * Fields:
 *   sourceId        — cache directory name under .cache/presets/<sourceId>/
 *   repository      — upstream URL, also used as Preset.source.origin
 *   tarball         — codeload URL to fetch, or null when already on disk
 *   licence         — SPDX id (must pass isLicenceAcceptable)
 *   licenceMarkers  — substrings that must all appear in the LICENSE text
 *   attribution     — notice the licence requires us to show, or null
 *   formats         — ['xmp'] or ['cube']
 *   pathFilter      — glob, relative to the extracted root, selecting source files
 *   groupFrom       — 'xmpGroup' | 'path' — how to derive a preset's category
 *   priority        — small integer, lower wins on duplicates
 *   manifest        — optional loader for a machine-readable sidecar (names/
 *                     categories/blurbs); the settings still come from the files
 */
export const SOURCES = [
  {
    sourceId: 'emulsion',
    repository: 'https://github.com/peva3/EmulsionPresets',
    tarball: 'https://codeload.github.com/peva3/EmulsionPresets/tar.gz/refs/heads/main',
    licence: 'MIT',
    // Already extracted by hand; acquire only verifies the licence, never re-fetches.
    alreadyExtracted: true,
    licenceMarkers: ['MIT License', 'Permission is hereby granted', 'WITHOUT WARRANTY'],
    attribution: null,
    formats: ['xmp'],
    pathFilter: 'Presets/**/*.xmp',
    groupFrom: 'xmpGroup',
    priority: 1,
    manifest: 'emulsion',
  },
  {
    sourceId: 'hstockeb',
    repository: 'https://github.com/hstockeb/film-simulations-and-presets',
    tarball: 'https://codeload.github.com/hstockeb/film-simulations-and-presets/tar.gz/refs/heads/main',
    licence: 'CC-BY-4.0',
    licenceMarkers: ['Creative Commons', 'Attribution'],
    attribution:
      'based on Hstockeb Lightroom Presets & Film Simulations by Hernan Stockebrand (https://github.com/hstockeb/film-simulations-and-presets), CC BY 4.0, with changes',
    formats: ['xmp'],
    pathFilter: 'presets/**/*.xmp',
    groupFrom: 'path',
    priority: 2,
    // site/looks.json mirrors the tree; XMP attributes remain the settings source.
    manifest: 'hstockeb',
  },
  {
    sourceId: 'irc-cinelike',
    repository: 'https://github.com/IRCGraphic/D-Cinelike-and-Normal-Blockbuster-LUTs',
    tarball: 'https://codeload.github.com/IRCGraphic/D-Cinelike-and-Normal-Blockbuster-LUTs/tar.gz/refs/heads/main',
    licence: 'CC0-1.0',
    licenceMarkers: ['CC0', 'Creative Commons'],
    attribution: null,
    formats: ['cube'],
    pathFilter: '**/*.cube',
    groupFrom: 'path',
    priority: 3,
    manifest: null,
  },
  {
    sourceId: 'slay-luts',
    repository: 'https://github.com/slaycamera/luts',
    tarball: 'https://codeload.github.com/slaycamera/luts/tar.gz/refs/heads/main',
    licence: 'CC-BY-4.0',
    licenceMarkers: ['Creative Commons', 'Attribution'],
    attribution: 'slay — slaycamera.com',
    formats: ['cube'],
    pathFilter: '**/*.cube',
    groupFrom: 'path',
    priority: 4,
    manifest: null,
  },
  {
    sourceId: 'a6000-luts',
    repository: 'https://github.com/jonmatifa/a6000-LUTs',
    // This repository's default branch is `master`, not `main`.
    tarball: 'https://codeload.github.com/jonmatifa/a6000-LUTs/tar.gz/refs/heads/master',
    licence: 'CC0-1.0',
    licenceMarkers: ['CC0', 'Creative Commons'],
    attribution: null,
    formats: ['cube'],
    pathFilter: '**/*.cube',
    groupFrom: 'path',
    priority: 5,
    manifest: null,
  },
];

/**
 * Sources we considered and refused. They appear in the report so the decision
 * is on the record, but the acquire step must never download them.
 */
export const REJECTED_SOURCES = [
  {
    sourceId: 'jack4b-retro-film',
    repository: 'https://github.com/Jack4B/Retro-Film-LUTs',
    licence: 'CC-BY-SA-4.0',
    reason:
      'CC BY-SA share-alike would force us to re-license the derived preset table; the pack is also 378 MB.',
    formats: ['cube'],
  },
  {
    sourceId: 'yahiaangelo-film-luts',
    repository: 'https://github.com/YahiaAngelo/Film-Luts',
    licence: 'unknown',
    reason: 'Re-hosted third-party pack; its own README disclaims ownership, so we cannot trust the licence.',
    formats: ['cube'],
  },
  {
    sourceId: 'scernst13-haldclut',
    repository: 'https://github.com/scernst13/HaldCLUT-Cube-Files',
    licence: 'CC0-1.0',
    reason: 'CC0 is claimed over unattributed upstream HaldCLUT work, so the waiver is not the claimant’s to give.',
    formats: ['cube'],
  },
  {
    sourceId: 'changyun233-lumix-vlog',
    repository: 'https://github.com/changyun233/Lumix-V-log-LUTs',
    licence: 'unknown',
    reason: 'Bundles Panasonic’s official .vlt files and a third-party pack whose licence is not stated.',
    formats: ['cube'],
  },
  {
    sourceId: 'abpy-fujifilm-profiles',
    repository: 'https://github.com/abpy/FujifilmCameraProfiles',
    licence: 'unknown',
    reason: 'No licence file; camera profiles are proprietary Adobe .dng-adj data regardless.',
    formats: ['xmp'],
  },
  {
    sourceId: 'docm88-free-lut-pack',
    repository: 'https://github.com/DocM88/Free-Lut-Pack',
    licence: 'unknown',
    reason: 'No licence file at all, so nothing here may be redistributed.',
    formats: ['cube'],
  },
  {
    sourceId: 'videovillage-red-luts',
    repository: 'https://github.com/videovillage/RED-Conversion-LUTs',
    licence: 'unknown',
    reason: 'Reverse-engineered proprietary RED gamma; redistribution is not ours to authorise.',
    formats: ['cube'],
  },
  {
    sourceId: 'tareqameer-chroma',
    repository: 'https://github.com/TareqAmeer/Chroma-App',
    licence: 'GPL-3.0',
    reason: 'GPL/AGPL copyleft attaches to the bundled data, which we are not prepared to carry into a preset table.',
    formats: ['cube'],
  },
];

/** Registry order the importer walks: accepted sources first, by priority. */
export function acceptedSources() {
  return [...SOURCES].filter((s) => isLicenceAcceptable(s.licence)).sort((a, b) => a.priority - b.priority);
}
