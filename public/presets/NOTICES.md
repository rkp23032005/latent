# Preset sources and licences

Built by `scripts/presets/build-library.mjs` on 2026-11-02. 699 entries ship in `public/presets/library.json`: 663 can be reproduced by this engine, and 36 were read but need stages it does not have. Those are listed in the browser as reference only, so the count stays honest.

Every accepted source was checked against the licence text on disk before it was
read, and only these SPDX ids are ever accepted: MIT, CC0-1.0, CC-BY-4.0,
Apache-2.0, BSD-3-Clause, Unlicense. The full licence text of each source is
copied next to this file.

## Accepted sources

### emulsion

- Repository: https://github.com/peva3/EmulsionPresets
- Licence: MIT (LICENSE)
- Licence text shipped with this app: `public/presets/licences/emulsion.txt`
- Formats: xmp
- Files read: 451 · looks shipped: 441 · invalid: 0 · duplicates: 10
- Required notice: none beyond the licence text above.
- Why accepted: accepted: licence verified

### hstockeb

- Repository: https://github.com/hstockeb/film-simulations-and-presets
- Licence: CC-BY-4.0 (LICENSE)
- Licence text shipped with this app: `public/presets/licences/hstockeb.txt`
- Formats: xmp
- Files read: 79 · looks shipped: 79 · invalid: 0 · duplicates: 0
- Required notice: based on Hstockeb Lightroom Presets & Film Simulations by Hernan Stockebrand (https://github.com/hstockeb/film-simulations-and-presets), CC BY 4.0, with changes
- Why accepted: accepted: licence verified

### irc-cinelike

- Repository: https://github.com/IRCGraphic/D-Cinelike-and-Normal-Blockbuster-LUTs
- Licence: CC0-1.0 (LICENSE)
- Licence text shipped with this app: `public/presets/licences/irc-cinelike.txt`
- Formats: cube
- Files read: 10 · looks shipped: 9 · invalid: 1 · duplicates: 0
- Required notice: none beyond the licence text above.
- Why accepted: accepted: licence verified

### slay-luts

- Repository: https://github.com/slaycamera/luts
- Licence: CC-BY-4.0 (LICENSE)
- Licence text shipped with this app: `public/presets/licences/slay-luts.txt`
- Formats: cube
- Files read: 5 · looks shipped: 5 · invalid: 0 · duplicates: 0
- Required notice: slay — slaycamera.com
- Why accepted: accepted: licence verified

### a6000-luts

- Repository: https://github.com/jonmatifa/a6000-LUTs
- Licence: CC0-1.0 (LICENSE)
- Licence text shipped with this app: `public/presets/licences/a6000-luts.txt`
- Formats: cube
- Files read: 3 · looks shipped: 3 · invalid: 0 · duplicates: 0
- Required notice: none beyond the licence text above.
- Why accepted: accepted: licence verified

## Refused sources

Not downloaded, not read, not mixed in. Recorded here because a silent omission
would look like an omission of the research rather than of the files.

| Source | Licence | Reason |
| --- | --- | --- |
| https://github.com/Jack4B/Retro-Film-LUTs | CC-BY-SA-4.0 | CC BY-SA share-alike would force us to re-license the derived preset table; the pack is also 378 MB. |
| https://github.com/YahiaAngelo/Film-Luts | unknown | Re-hosted third-party pack; its own README disclaims ownership, so we cannot trust the licence. |
| https://github.com/scernst13/HaldCLUT-Cube-Files | CC0-1.0 | CC0 is claimed over unattributed upstream HaldCLUT work, so the waiver is not the claimant’s to give. |
| https://github.com/changyun233/Lumix-V-log-LUTs | unknown | Bundles Panasonic’s official .vlt files and a third-party pack whose licence is not stated. |
| https://github.com/abpy/FujifilmCameraProfiles | unknown | No licence file; camera profiles are proprietary Adobe .dng-adj data regardless. |
| https://github.com/DocM88/Free-Lut-Pack | unknown | No licence file at all, so nothing here may be redistributed. |
| https://github.com/videovillage/RED-Conversion-LUTs | unknown | Reverse-engineered proprietary RED gamma; redistribution is not ours to authorise. |
| https://github.com/TareqAmeer/Chroma-App | GPL-3.0 | GPL/AGPL copyleft attaches to the bundled data, which we are not prepared to carry into a preset table. |

## Original looks

The remaining looks (162) were written by this project's own script and
measured with this project’s own engine. They are recipes for the engine’s own knobs; they do
not reproduce, claim to reproduce, or depend on any proprietary camera profile,
film simulation or vendor preset, and they carry no third-party attribution.
