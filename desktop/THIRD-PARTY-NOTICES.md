# Third-party software notices — Luma for Windows

Luma redistributes selected, **unmodified upstream executables and DLLs** for audio download, conversion and JavaScript challenge execution. Their licenses remain separate from Luma's application source license. No tool source code or binary contents were modified by Luma; files were arranged into the application's `resources/tools` directory.

The original download URLs and SHA-256 hashes are recorded in `resources/tools/manifest.json`. Complete license texts collected for these tools are in `resources/tools/licenses/`; the original FFmpeg archive's license, documentation, headers, import libraries and presets are retained in `resources/tools/ffmpeg-distribution/`. A copy of this notice is included beside the tools.

## yt-dlp — 2026.10.26

- Project: [yt-dlp](https://github.com/yt-dlp/yt-dlp).
- Executable: `yt-dlp.exe`, official Windows PyInstaller build from [release 2026.10.26](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26).
- Download: [official Windows executable](https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe).
- SHA-256: `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d`.
- Matching yt-dlp revision: [`f264a6cbd1f630894da0f368df00f8aae50140e0`](https://github.com/yt-dlp/yt-dlp/tree/f264a6cbd1f630894da0f368df00f8aae50140e0).
- Source archive: [release source](https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.10.26.tar.gz).

yt-dlp itself is released under the **Unlicense**. The bundled Windows executable also contains third-party code with additional licenses; it must not be described as exclusively Unlicense. Upstream's cross-platform aggregate notice includes GPL-3.0-or-later, GPL-2.0-or-later, LGPL, MPL, PSF, Apache, BSD, MIT and other component terms. Some entries are explicitly Linux-only, so this list does not mean every listed component is present in the Windows executable. The exact aggregate text, including complete applicable license texts and component source links, is preserved without modification as **`licenses/yt-dlp-THIRD-PARTY-LICENSES.txt`**. The core Unlicense is **`licenses/yt-dlp-LICENSE.txt`**.

Official documents for this exact revision:

- [Core license](https://github.com/yt-dlp/yt-dlp/blob/f264a6cbd1f630894da0f368df00f8aae50140e0/LICENSE).
- [Third-party licenses and source information](https://github.com/yt-dlp/yt-dlp/blob/f264a6cbd1f630894da0f368df00f8aae50140e0/THIRD_PARTY_LICENSES.txt).
- [Build and release workflows](https://github.com/yt-dlp/yt-dlp/tree/f264a6cbd1f630894da0f368df00f8aae50140e0/.github/workflows).

Source for bundled dependencies can be obtained from the original projects identified in that aggregate notice. Its upstream source-availability statement also identifies `maintainers@yt-dlp.org` when those component sources cannot be obtained; that contact is the upstream project, not a source-offer made by Luma.

## FFmpeg / ffprobe — BtbN Windows LGPL shared build

- Project: [FFmpeg](https://ffmpeg.org/).
- Runtime version: **`n9.0.2-39-g7adfbe40dc-20261031`**.
- Included files: `ffmpeg.exe`, `ffprobe.exe`, `avcodec-63.dll`, `avdevice-63.dll`, `avfilter-12.dll`, `avformat-63.dll`, `avutil-61.dll`, `swresample-7.dll`, `swscale-10.dll`.
- Distributor / build recipes: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- Downloaded archive: `ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip`; SHA-256 **`f589c0796890c197d31e7cd221c080ffd0fe09362301329743a50140a10dbe86`**. The original URL is preserved in `manifest.json`.
- Dated release for this FFmpeg revision: [`autobuild-2026-10-31-12-59`](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59); [dated binary archive](https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/ffmpeg-n9.0.2-39-g7adfbe40dc-win64-lgpl-shared-9.0.zip). That dated ZIP has a different archive checksum from the original floating-`latest` ZIP actually bundled by Luma; it must not be substituted under the manifest's original SHA-256. The manifest remains the record of the actual supplied archive.
- FFmpeg source revision: [`7adfbe40dc`](https://github.com/FFmpeg/FFmpeg/commit/7adfbe40dc); [corresponding FFmpeg source archive](https://github.com/FFmpeg/FFmpeg/archive/7adfbe40dc.tar.gz).
- BtbN recipe revision: [`5031c6f`](https://github.com/BtbN/FFmpeg-Builds/commit/5031c6f); [dated recipe source archive](https://github.com/BtbN/FFmpeg-Builds/archive/refs/tags/autobuild-2026-10-31-12-59.tar.gz).

This build reports **GNU Lesser General Public License version 3 or later** (`ffmpeg -L`). Its configuration includes `--enable-version3 --enable-shared --disable-static`, with GPL / nonfree variants disabled. The preserved upstream LGPL text is **`ffmpeg-distribution/LICENSE.txt`**, also copied to **`licenses/FFmpeg-LGPLv3.txt`**. The GPLv3 text incorporated by LGPLv3 is included as **`licenses/GPLv3.txt`**, copied verbatim from the official yt-dlp aggregate license document. The FFmpeg source archive contains the full source licensing notices. BtbN's build scripts are MIT licensed; their text is **`licenses/BtbN-LICENSE.txt`**. The build-script MIT license does not replace FFmpeg's LGPL or external dependency licenses.

Luma calls FFmpeg as a separate process and retains its shared libraries as separate DLL files. Users may run a compatible modified FFmpeg build by changing the executable path in Settings. Luma imposes no additional restriction on reverse engineering needed to debug modifications to LGPL-covered software.

### Obtaining corresponding sources and build information

1. Obtain the FFmpeg source archive for commit **`7adfbe40dc`**, rather than the current moving `release/9.0` branch.
2. Obtain BtbN's build recipes from dated tag **`autobuild-2026-10-31-12-59`** / commit **`5031c6f`**. The `scripts.d/` recipes identify external dependency repositories, source downloads and build steps; use this pinned recipe version for dependencies and patches.
3. BtbN documents Bash and Docker with `./makeimage.sh win64 lgpl-shared 9.0`, followed by `./build.sh win64 lgpl-shared 9.0`. Its FFmpeg checkout must be pinned to **`7adfbe40dc`** for the source of this distribution, because running a moving release branch later may select newer sources. Compiler identification from the supplied executable is **GCC 16.2.0 / crosstool-NG 1.29.0.7_b1a94f6**.
4. Run `ffmpeg.exe -version` / `-buildconf` to inspect the supplied executable's complete configure flags. The FFmpeg source tree's `LICENSE.md` and each external project's license govern their respective portions.

The local `ffmpeg-distribution/` folder contains the upstream binary archive's accompanying files; it is **not a complete corresponding-source bundle** for FFmpeg and all externally linked code. The source and recipe links above identify upstream retrieval locations. Any further distributor must preserve applicable notices and provide corresponding source under the applicable licenses; an attribution list alone is not a replacement for those source-provision requirements.

## Deno — v2.9.8

- Project: [Deno](https://github.com/denoland/deno).
- Included executable: `deno.exe`, official Windows x86-64 build.
- Original archive: [deno-x86_64-pc-windows-msvc.zip](https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-pc-windows-msvc.zip).
- Original archive SHA-256: **`cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf`**.
- Source: [tag v2.9.8](https://github.com/denoland/deno/tree/v2.9.8), [source archive](https://github.com/denoland/deno/archive/refs/tags/v2.9.8.tar.gz).
- License: **MIT**, copyright **2018–2026 the Deno authors**. The complete official text is included as **`licenses/Deno-LICENSE.txt`**; [upstream license](https://github.com/denoland/deno/blob/v2.9.8/LICENSE.md).

Deno's source and dependency manifests identify its third-party dependencies and their respective licenses. These remain governed by their original terms. Luma supplies Deno solely as a standalone runtime used by yt-dlp's EJS challenge solver.

## 7-Zip — 24.09 portable launcher helper

The Windows portable launcher embeds the unmodified **7-Zip 24.09 `7za.exe` (x86)** to extract its application payload. Copyright **1999–2024 Igor Pavlov**. 7-Zip is primarily **GNU LGPL version 2.1 or later**; upstream's license also identifies BSD / public-domain portions and the unRAR restriction for applicable source files. The full upstream texts are preserved in the source project as **`build/launcher-licenses/COPYING`** and **`build/launcher-licenses/LICENSE.txt`**, and are included with the launcher. No extractor binary was modified.

Obtain this version's source from [official release 24.09](https://github.com/ip7z/7zip/releases/tag/24.09) or the [24.09 source archive](https://github.com/ip7z/7zip/archive/refs/tags/24.09.tar.gz). The [official 7-Zip download page](https://www.7-zip.org/download.html) links current and historical source distributions. These extractor terms are separate from Luma's launcher/application source license.

## Application dependencies

The Electron / Chromium runtime includes its own `LICENSE` and `LICENSES.chromium.html` in the Windows distribution. React, Tailwind CSS, lucide-react, music-metadata, fluent-ffmpeg and other npm dependencies retain the license and notice files in their respective installed packages. `package-lock.json` records the source dependency versions used by the project.

This notice does not remove any third-party warranty disclaimer or grant rights beyond the corresponding upstream license. Preserve this notice, the copied license texts, the download manifest and the upstream accompanying files when redistributing the tools.
