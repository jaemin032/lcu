# Windows x64 Store build 26.1111.2228.0

Windows registered `OpenAI.Codex` `26.1111.2228.0`, x64, with the OpenAI package publisher and `SignatureKind` set to `Store`. The package matched its identity manifest and passed LCU's application tree and required-file checks. The [official Store update manifest](https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json) identified this build as release `26.1111.21308`, which is also the version declared by the installed `computer-use` and `unified-computer-use` plugins. The installed CUA manifest reported runtime archive version `local` and Node `24.22.1-cua.1` (binary version `24.22.1`). The native desktop checks below are the basis for this pair's informational `tested-versions.json` entry.

## Original host and standalone wiring

The previous analyzer reported that it could not find a native-pipe host. The installed `app.asar` had SHA-256 `2551cba1057a05cdc5cf5d75b146fac4092bff4ce77a10c43e3286c88d24c82d`. [Reverse Engineer Anything](https://github.com/morluto/rea) 6.9.0 inventoried the archive and statically analyzed the selected host declaration in `.vite/build/early-bootstrap-331-29198f5b57adf59a.js`. The full chunk exceeded REA's 1 GiB JavaScript worker budget. Its archive scan also recorded eight integrity contradictions in unpacked native files. The selected JavaScript declaration was read from the packed chunk. Acorn established its exact lexical placement.

The original server factory is now the default for a destructured `startServer` option on a wrapper called by the Electron startup function. That original factory accepts the four existing path and pipe options and returns `pipePath`, `closeActiveTurn`, `hasActiveTurn`, and `dispose`. LCU recognizes the layout by its syntax and options, and carries the factory expression verbatim with its module-scope dependencies. Extraction refuses a supplied `startServer` override or dependencies on either enclosing function's local bindings. The existing webpack adapter loads the dependencies and the existing Windows launch entry supplies the paths and lifetime wiring.

## Verification and limits

- `scripts/check_windows_host_layout.py` ran against the installed archive with a temporary, hash-matched copy of its own Node `24.22.1`. The derived original host loaded with Electron blocked, opened a temporary Windows named pipe, returned `false` for an unknown turn, and disposed of the pipe. The extraction and Node copy were temporary.
- Regression coverage exercises both webpack layouts with synthetic bundles. The new fixture checks verbatim extraction, dependency resolution, startup scope and override rejection, and successful loading without the Electron wrapper. The focused Windows tests passed 65 of 66 cases in a disposable Linux container, with one platform-specific skip. On this Windows account, three existing cases stop at `symlinkSync` with `EPERM`. The same failures reproduced on the unmodified checkout.

## Installed Windows 11 x64 desktop

The task-owned Generation 2 Hyper-V guest used [Windows 11 Enterprise LTSC Evaluation](https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise) build `26100.1742` with Secure Boot, a virtual TPM, and a newly created guest-only local account. The English x64 ISO matched SHA-256 `67cec5865eaa037a72ddc633a717a10a2bed50778862267223ddb9c60ef5da68`. It ran with zero active network adapters. The official [OpenAI MSIX](https://persistent.oaistatic.com/codex-app-prod/releases/26.1111.2228.0/ChatGPT-x64.msix) had SHA-256 `9af8619e929f00369a47326717f9515205a0e25dd409bc4c29af62c74c1ed898`. Windows registered it offline with the official publisher and Store signature before LCU setup. Its installed `app.asar` SHA-256 matched the workload PC's Store installation.

The thin x64 candidate ZIP with SHA-256 `1442a9479971eaaa4a429cb31781a5a833472f44961a137553fce78d57518039` passed the archive payload audit. `scripts/install.ps1 --runtime-only` passed offline from the guest's interactive session at limited privilege. The stable launcher reported `lcu 0.13.8 (ChatGPT windows 26.1111.2228.0; CUA local)`. The shared MCP SDK client started this launcher with no arguments and exercised the actual desktop through the installed runtime's `@oai/sky` Window2 API.

| Check | Guest result |
| --- | --- |
| Original MCP and discovery | `js` and `js_reset` were visible. `sky.list_windows()` found the WinForms fixture by its exact title. |
| Original app approval and capture | Declining the `computer-use` elicitation for the fixture returned no image. A separate turn with **Allow once** returned the fixture accessibility tree and a valid 13,736-byte JPEG. Subsequent protected calls elicited their own approval. |
| Native click and Unicode | An accessibility-index click focused the draft, `Control_L+a` selected its text, and `sky.type_text` entered `LCU native proof: 한글 café λ 東京`. A second indexed click saved through the fixture's own button handler. An independent read matched all 40 UTF-8 bytes, SHA-256 `baf205692416750968c4399b03c9c2b51c73c8766ee8b9a742c492e077b324c3`. |
| Turn and connection lifetime | A stale Stop left the active turn's helper PIDs running. A matching Stop closed both. After a new approved window capture, matching Interrupt closed its helpers. After another capture, closing the actual MCP connection closed the final helpers. |

A separate probe interrupted a turn that had only called `list_windows`. One helper remained until the MCP connection closed. The matching Interrupt pass above covers a turn with an approved capture. Windows browser actions, real model calls, and the signed-in desktop app's approval UI were outside this guest test. See [parity status](../PARITY-STATUS.md).
