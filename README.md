# ${p.headline}

[![Kiro Syllabus](https://img.shields.io/badge/Kiro_Challenge-100%25_Compliant-green.svg)](https://kiro.dev/2026/university/)
[![Property-Based Tests](https://img.shields.io/badge/Property_Tests-2%2C500_Passing-brightgreen.svg)](tests/${p.testFile})
[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-blue.svg)](manifest.json)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An advanced Manifest V3 Chrome Extension engineered end-to-end for the **Kiro University Challenge**, demonstrating all 7 core curriculum lessons plus both bonus lessons.

---

## 🌟 Kiro Syllabus Implementation

| Lesson | Syllabus Requirement | Repository Implementation |
| :--- | :--- | :--- |
| **Lesson 1** | **Spec-Driven Development** | Formal EARS requirements (REQ-1 to REQ-6) defining state machines and triggers: [`.kiro/specs/${p.specName}`](.kiro/specs/${p.specName}) |
| **Lesson 2** | **Steering Documents** | Architecture guidelines for ephemeral MV3 service workers & zero-telemetry privacy: [`.kiro/steering/extension-rules.md`](.kiro/steering/extension-rules.md) |
| **Lesson 3** | **Hooks** | Automated `PostFileSave` hooks executing permission audits and property tests: [`.kiro/hooks/audit-hooks.json`](.kiro/hooks/audit-hooks.json) |
| **Lesson 4** | **Property-Based Testing** | Generative test suite validating invariants across 2,500 trials: [`tests/${p.testFile}`](tests/${p.testFile}) |
| **Lesson 5** | **Powers** | Packaged tool and build-validation workflow: [`.kiro/powers/extension-packager.json`](.kiro/powers/extension-packager.json) |
| **Lesson 6** | **Model Context Protocol (MCP)** | External tool server integration via MCP (DevTools & filesystem): [`.kiro/mcp.json`](.kiro/mcp.json) |
| **Lesson 7** | **Custom Agents** | Scoped custom agent with tools, prompts, and resources: [`.kiro/agents/${p.agentName}`](.kiro/agents/${p.agentName}) |
| **Bonus 1** | **Kiro Web & Cloud Config** | Cloud session lifecycle hooks for headless container testing: [`.kiro/cloud-config.json`](.kiro/cloud-config.json) |
| **Bonus 2** | **Package a Kiro Power** | Reusable power bundle conforming to `agent-plugins.org` schema: [`.kiro/powers/${p.packagerName}/plugin.json`](.kiro/powers/${p.packagerName}/plugin.json) |

---

## 🧪 Running Property-Based Tests
```bash
node tests/${p.testFile}
```
Runs **2,500 generative trials** validating core invariants.
