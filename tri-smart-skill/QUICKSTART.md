# TriSmart Skill quick start

Version 1.1.0

TriSmart Skill lets two or three subscription developer tools think through an important design together before ordinary coding begins.

1. Install the official developer CLIs you want to use: Claude Code, Codex, and/or Grok Code.

   Official starting points: [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started), [OpenAI Developers](https://developers.openai.com/), and [Grok CLI reference](https://docs.x.ai/build/cli/reference). Follow each provider's current instructions; ModelMesh does not install third-party wrappers.
2. Unzip this package.
3. Start the installer for your operating system: double-click `install.command` on macOS, double-click `install.cmd` on Windows, or run `./install.sh` on Linux. If you prefer a terminal, run `node install.mjs` from the extracted folder. It installs to your user-level host directories by default; use `--project=/path/to/project` for a project-local install.
4. The installer copies the skill into the host-specific directory and starts the guided OAuth walkthrough:

   ```sh
node install.mjs
```

Prefer a customized setup? Skip the installer and drag the extracted `tri-smart` folder into the skill directory for your host: `.claude/skills/tri-smart/`, `.agents/skills/tri-smart/`, or `.grok/skills/tri-smart/`. Reload the host afterward.

5. Follow each provider's official browser login. TriSmart never asks for an API key and never stores login tokens.

On macOS, the first double-click may show a Gatekeeper warning because the launcher is unsigned. Control-click `install.command`, choose **Open**, then choose **Open** again. The terminal fallback is `./install.sh`.
6. When setup finishes, ask your current coding assistant:

   ```text
   Use ModelMesh to review this architecture before implementation: [describe the decision]
   ```

TriSmart chooses **TriSmart** when all three providers are available. With any two it chooses **Dual** and tells you which pair is active. It uses the highest model your account can actually run, or that provider's verified default when your plan does not include the preferred model.

You will see a plain-language update for every stage: independent proposals, adversarial challenge, one shared synthesis, and independent verification. If the reviewers identify an unresolved critical issue, the result is **blocked** and nothing is handed to implementation. That is an intentional safety result.

Preview installation without changing files or logging in:

```sh
node install.mjs --dry-run
```
