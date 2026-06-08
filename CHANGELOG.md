## [1.3.0](https://github.com/florentleveque/mural-mcp-serveur/compare/v1.2.0...v1.3.0) (2026-06-08)

### Features

* **export:** add get-export-status and download-export tools ([eff481e](https://github.com/florentleveque/mural-mcp-serveur/commit/eff481eb9138c1fd4f5c50b79f1548012c40619c)), closes [#11](https://github.com/florentleveque/mural-mcp-serveur/issues/11)

### Bug Fixes

* **export:** treat 404 EXPORT_NOT_FOUND as still-processing in getExportStatus ([6de56af](https://github.com/florentleveque/mural-mcp-serveur/commit/6de56afb338af6805a4722d652c3cbcf41ad7e13))

## [1.2.0](https://github.com/florentleveque/mural-mcp-serveur/compare/v1.1.0...v1.2.0) (2026-06-08)

### Features

* **client:** derive 429 wait time from x-ratelimit-reset headers ([49271e8](https://github.com/florentleveque/mural-mcp-serveur/commit/49271e8d680bf09c78747d15b84dbdfb57013548)), closes [#9](https://github.com/florentleveque/mural-mcp-serveur/issues/9)
* **client:** introduce typed MuralApiError and replace message-based error checks ([eab1087](https://github.com/florentleveque/mural-mcp-serveur/commit/eab10874531d9229dc42cf8eb4cd15a29ef1e655)), closes [#9](https://github.com/florentleveque/mural-mcp-serveur/issues/9)
* **server:** add verbose escape hatch to board/room/workspace/template reads ([d6ee84c](https://github.com/florentleveque/mural-mcp-serveur/commit/d6ee84cccec048e1bfed4768de28bb3d974bb74d))
* **server:** centralize MCP response formatting; fix getMuralWidget double-value ([5a83bb0](https://github.com/florentleveque/mural-mcp-serveur/commit/5a83bb0bf79e0a547435f761b5ea329d3513e162))
* **server:** expose status and errorCode in MCP error responses ([9c5d94f](https://github.com/florentleveque/mural-mcp-serveur/commit/9c5d94f386083ba7251195c0b6a5e14f18a28040)), closes [#9](https://github.com/florentleveque/mural-mcp-serveur/issues/9)
* **types:** align interfaces with real Mural API + add compact projections ([6ce688d](https://github.com/florentleveque/mural-mcp-serveur/commit/6ce688d25bfa4eb0d82c99b3d9fa961c3d198654))

### Bug Fixes

* **projections:** keep text content of 'text' widgets ([37dbaea](https://github.com/florentleveque/mural-mcp-serveur/commit/37dbaea23d5da98917fc2356341adb8ba69a88b8))
* **projections:** preserve text/title for unmodeled widget types; drop empty strings ([e65db9d](https://github.com/florentleveque/mural-mcp-serveur/commit/e65db9d98ec4e0c4a48031f2b0efc6200e2a5ab1))

## [1.1.0](https://github.com/florentleveque/mural-mcp-serveur/compare/v1.0.0...v1.1.0) (2026-06-07)

### Features

* **tests:** set up vitest unit testing infrastructure ([e276639](https://github.com/florentleveque/mural-mcp-serveur/commit/e2766398841ca0f3694cb316974b91f5444f92da))

### Bug Fixes

* **client:** do not retry 4xx client errors ([35a73a6](https://github.com/florentleveque/mural-mcp-serveur/commit/35a73a68772126f7eea3186f3afc1e205f85ab16))

## 1.0.0 (2026-06-07)

### Features

* add board (mural) listing tools for workspaces and rooms ([9c6e941](https://github.com/florentleveque/mural-mcp-serveur/commit/9c6e9418ce1b7a44bb15a687c57f664dd1e75a4f))
* add comprehensive Contents API support with 9 new MCP tools ([327848e](https://github.com/florentleveque/mural-mcp-serveur/commit/327848e27a323c348a3e2280cb7c103bd5860c3a))
* add comprehensive OAuth scope checking with enhanced error messages ([50e35ef](https://github.com/florentleveque/mural-mcp-serveur/commit/50e35ef6bf3db350cdc2e48e3f714b0ac6a99895))
* add debug-api-response tool for troubleshooting empty workspace responses ([fa22e14](https://github.com/florentleveque/mural-mcp-serveur/commit/fa22e14da07bd0850a4d3b4db68e53c00c08bc24))
* complete CRUD operations with comprehensive PATCH tools and integration tests ([980311c](https://github.com/florentleveque/mural-mcp-serveur/commit/980311cb141c27fc03eec872954f8808b463ba76))
* complete OAuth scope coverage with templates support ([e86350b](https://github.com/florentleveque/mural-mcp-serveur/commit/e86350b7c33d2cd47dc498f3594aa75fc531f4e2))
* **config:** require MURAL_CLIENT_SECRET with an explicit error ([25acc79](https://github.com/florentleveque/mural-mcp-serveur/commit/25acc798726932a5cb1e101b6570a913988870e8))
* expose shape, arrow, text-box, title, area widget tools + fix delete-widget ([7b168c2](https://github.com/florentleveque/mural-mcp-serveur/commit/7b168c26880f89ad97a2d78c0076428692a0268b))
* implement comprehensive rate limiting with token bucket algorithm ([63e2aa4](https://github.com/florentleveque/mural-mcp-serveur/commit/63e2aa48e947953fee89a34c4dbd3f1162ac7e33))
* initial implementation of Mural MCP server v0.0.1 ([72f90a4](https://github.com/florentleveque/mural-mcp-serveur/commit/72f90a404f713bc7243d6dad515149b25c7d9fa7))
* **tools:** add create-room tool ([c5991b6](https://github.com/florentleveque/mural-mcp-serveur/commit/c5991b6db548e1a6586f5b147fb2225828c0c3c7)), closes [#3](https://github.com/florentleveque/mural-mcp-serveur/issues/3) [#4](https://github.com/florentleveque/mural-mcp-serveur/issues/4)
* **tools:** add mural CRUD tools (create/update/delete/duplicate/export) ([a229a58](https://github.com/florentleveque/mural-mcp-serveur/commit/a229a581beda152277f642b1286c661847bce05e))
* **tools:** add room and template read tools (+ create from template) ([f46d5a1](https://github.com/florentleveque/mural-mcp-serveur/commit/f46d5a1d42a1b27493aca2fb47992ece0623142c)), closes [#3](https://github.com/florentleveque/mural-mcp-serveur/issues/3)

### Bug Fixes

* **client:** paginate getMuralWidgets to return all widgets ([07673af](https://github.com/florentleveque/mural-mcp-serveur/commit/07673af645aec010d128e6ac047d599db5ba3561))
* correct API response parsing for list-workspaces tool ([bb47d53](https://github.com/florentleveque/mural-mcp-serveur/commit/bb47d5391fb83263c2e8ae5e7c4e113b6caf4edb))
* implement auto-sizing for sticky notes to prevent text truncation ([ad6a276](https://github.com/florentleveque/mural-mcp-serveur/commit/ad6a276e0c0496542746ec0aa8f1fd6b51ebb73f))
* migrate all Contents API endpoints from legacy to RESTful architecture ([2ab6f36](https://github.com/florentleveque/mural-mcp-serveur/commit/2ab6f36cb7aa113c248dd243f7ad6ca0377ffade))
* **oauth:** prevent server crash when the browser cannot be opened ([3eed021](https://github.com/florentleveque/mural-mcp-serveur/commit/3eed0219d26f79386005a2f68c172b9a16c1f72f))
* resolve OAuth multiple browser window authentication issue ([b04a50b](https://github.com/florentleveque/mural-mcp-serveur/commit/b04a50b1e05df0b8191e800c9181a50d1f945c35))
* resolve OAuth scope extraction from JWT access tokens ([8b343c2](https://github.com/florentleveque/mural-mcp-serveur/commit/8b343c27a4cf18e9a1408ae2e664acb69b334360))
* resolve sticky note creation payload structure and add comprehensive test suite ([b226785](https://github.com/florentleveque/mural-mcp-serveur/commit/b2267859105f59995e927bb15c59e06ad7593205))
