# Changelog
## 0.3.2

- fix(ci): stage CHANGELOG.md in preReleaseCommand and use PAT for tag creation by @BYK in [7461fa63](https://github.com/BYK/opencode-lore/commit/7461fa635247d06b321a7ed45ecf1b0468a004be)
- fix(ci): checkout release branch for CHANGELOG.md and set git identity by @BYK in [30a318e6](https://github.com/BYK/opencode-lore/commit/30a318e68e121635f4ccea7b18ad311c94027240)
- fix(ci): set artifactProvider to none for github-only target by @BYK in [87dafec1](https://github.com/BYK/opencode-lore/commit/87dafec1b4065ab0a4c81afd585d1d59742bfd1d)
- fix(ci): wrap preReleaseCommand in bash for env var expansion by @BYK in [2dce6728](https://github.com/BYK/opencode-lore/commit/2dce67289e6705ee59da31edcee4485df0da9633)
- fix(ci): revert to github-only Craft target with separate npm OIDC publish by @BYK in [a5646f0a](https://github.com/BYK/opencode-lore/commit/a5646f0abf25cd39d3be87153b4ff99c35bae2ef)
- fix(ci): remove registry-url from setup-node to avoid OIDC interference by @BYK in [4f04d3c7](https://github.com/BYK/opencode-lore/commit/4f04d3c7a62191288c3b26f90963297c0cd491f6)
- fix(ci): upgrade npm for OIDC trusted publishing (requires >=11.5.1) by @BYK in [ceeccf00](https://github.com/BYK/opencode-lore/commit/ceeccf00d944bc89f8b324bb22148e5eb62793b9)
- fix(ci): configure artifact provider for npm tarball lookup by @BYK in [697a98cf](https://github.com/BYK/opencode-lore/commit/697a98cf73316ca1e0643df18b3abf3e5636616f)
- fix(ci): add actions:read permission for artifact download by @BYK in [cc05628c](https://github.com/BYK/opencode-lore/commit/cc05628c504bf6de3ecf2c7938c71dc386c98638)
- ci: upload npm tarball artifact on release branches by @BYK in [9d700397](https://github.com/BYK/opencode-lore/commit/9d700397c22f57b533f4ee44e23b7f16134a14c5)
- fix(ci): resolve version from Craft output instead of branch name by @BYK in [bd53d77c](https://github.com/BYK/opencode-lore/commit/bd53d77cdaa2e40e852a418a35b23fe6f22be169)
- fix(ci): add production environment to release job for PAT access by @BYK in [f3a6ebd5](https://github.com/BYK/opencode-lore/commit/f3a6ebd50e28c377d407cfc4d00137cf6ac0a1e7)
- fix(ci): use PAT for release branch push to trigger CI by @BYK in [b171b8c2](https://github.com/BYK/opencode-lore/commit/b171b8c225a884ea7cac56c36d660b056b8feaa6)
- ci: run CI on release branches for Craft status checks by @BYK in [067d1205](https://github.com/BYK/opencode-lore/commit/067d12052ec5689a3cac7807c2336544fc4055a5)
- fix(ci): use composite action for release to get issues:write permission by @BYK in [8da99bc0](https://github.com/BYK/opencode-lore/commit/8da99bc0036f15d227931f624b27a15d6bcaa58b)
- ci: use Craft npm target with OIDC trusted publishing by @BYK in [20c1be34](https://github.com/BYK/opencode-lore/commit/20c1be34864604257794df9a7c9cc1f4e27eb992)
- ci: upgrade to Craft 2.22 reusable workflow with accepted-label publish flow by @BYK in [7261873b](https://github.com/BYK/opencode-lore/commit/7261873b079efa4e3dfa9b56aa8f28d31a8740af)
- fix(ci): use Craft CLI directly instead of composite action by @BYK in [58dc4e87](https://github.com/BYK/opencode-lore/commit/58dc4e874dbca3b0772d5913d1b013e7f2425513)
- doc: add conventional commits convention to AGENTS.md by @BYK in [3dec8769](https://github.com/BYK/opencode-lore/commit/3dec876938abeb5b65d846ebd428335dc0d7463d)
- ci: add Craft release workflow with npm trusted publishing by @BYK in [6b0ad08b](https://github.com/BYK/opencode-lore/commit/6b0ad08b67e5fc4deb6065a09136498e2c01a469)

