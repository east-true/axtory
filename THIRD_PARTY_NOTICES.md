# Third-party notices

AXtory Core has no required runtime dependency beyond Node.js.

The optional `@anthropic-ai/claude-agent-sdk` is an Anthropic product. Its TypeScript repository
states that use is subject to Anthropic's Commercial Terms of Service; it is not covered by
AXtory's Apache-2.0 license. The SDK also offers platform-specific Claude Code binaries as
optional packages. AXtory does not bundle or redistribute the SDK or those binaries and expects
users to install the SDK without optional binaries and provide their existing `claude`
executable.

Codex is an OpenAI product and is not redistributed by AXtory. A future Codex connector will
use the installed `codex app-server` official protocol after a separate contract spike.

Dependency license and product-term checks are release gates and must be repeated; this file is
not a claim that current terms will remain unchanged.
