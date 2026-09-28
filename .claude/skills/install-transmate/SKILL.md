---
name: install-transmate
description: Install or update the local TransMate unpacked extension in the user's chosen Chrome browser and verify that it is enabled. Use for TransMate installation requests, not Chrome Web Store publishing.
---

# Install TransMate

This skill belongs to the TransMate source checkout. Its extension directory is three levels above this `SKILL.md` file. Resolve that directory to an absolute path and run `node scripts/check-install.mjs` there before installation. Use the script's `extensionDirectory` as the path to install. The directory containing `manifest.json` is the extension; do not select a parent directory or a temporary copy.

## Target browser

Use the Chrome browser and profile the user names. If none is named, target the profile in the user's foreground Chrome window. `--autoConnect` can choose the default profile when several profiles are open, so compare the connected profile's `chrome://version` **Profile Path** with the target profile before installing. If the paths differ or the target cannot be established, use desktop UI automation on the intended profile or ask the user which profile to target. An agent-created browser or temporary test profile is a different installation target.

The project supplies Chrome DevTools MCP configuration with `--categoryExtensions --autoConnect`. Codex must trust this exact project directory to load `.codex/config.toml`; Claude Code must approve the project MCP server. When its extension tools are available, call `list_extensions` for a baseline, then `install_extension` with the absolute `extensionDirectory`. `list_extensions` does not show source paths: never treat a matching name or version as proof that this checkout is installed. Use `reload_extension` only after independently confirming the installed source path. Connecting to the running Chrome requires remote debugging enabled at `chrome://inspect/#remote-debugging` and the browser's Allow prompt. Let the user handle browser or OS permission prompts; do not bypass them. If Chrome is older than 149, use the UI route below for an existing browser profile.

If the MCP tools cannot reach the target browser, use available desktop UI automation in that browser: open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the exact `extensionDirectory`. Chrome's ordinary builds do not support installing an extension through `--load-extension`; do not use a launch flag as proof of installation in the user's browser.

## Verification

After installation, use `list_extensions` or the target browser's Extensions page to confirm TransMate's name, extension version, extension ID, and enabled state. Match the ID returned by installation if available; report other same-named IDs rather than assuming they are this checkout. Open `chrome-extension://<id>/options.html` in that same profile to confirm the options page loads. If the check fails, fix the issue or report exactly what remains blocked. Never report an installation in a temporary browser as an installation in the user's Chrome.

Report the browser/profile, extension ID, version, and verification result. The user enters their own AI endpoint, model, and API key in Options; do not invent credentials or make a paid provider request to prove installation.
