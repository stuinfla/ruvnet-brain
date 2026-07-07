# agentic-qe — Primer

<!-- Generated primer · grounded in real source via rerankKb (big) · archetypes: what, capabilities, concepts, maturity, docs, use -->

## What it is & who it's for

# What it is & who it's for  

**Agentic QE (AQE)** is an AI-powered quality engineering platform that deploys **53 specialized testing agents** (`docs/agentic-qe-intro.md`) coordinated by a central Queen agent. It operates as:  

1. **A testing fleet** - Specialized agents handle tasks like vulnerability scanning (`agent-1767445028457-c3c732886307bd2e73.json`), test generation (`qe-test-generator.yaml`), and coverage analysis (`plugins/agentic-qe-fleet/.claude-plugin/plugin.json`)  
2. **A learning system** - Uses a ReasoningBank with 150K+ patterns (`docs/agentic-qe-intro.md`) and quantum-resistant version control (`qe-agentic-jujutsu/SKILL.md`)  
3. **An integration layer** - Exposes 60+ tools via CLI and Model Context Protocol (MCP) server (`docs/agentic-qe-intro.md`)  

### Who it's for:  
- **Developers** needing AI-generated tests (`agent-1767445182612-07612d17111cd44b9a.json`)  
- **QE teams** requiring sublinear coverage analysis (`plugins/agentic-qe-fleet/.claude-plugin/plugin.json`)  
- **Security engineers** leveraging OWASP Top 10 scans (`agent-1767445028457-c3c732886307bd2e73.json`)  
- **Architects** implementing TDD/DDD patterns (`qe-test-generator.yaml`)  

The system ships as an npm package and integrates with VS Code, Claude Code, and Cursor (`docs/agentic-qe-intro.md`).

## Capabilities (what it can do)

## Capabilities (what it can do)

Agentic-qe is a comprehensive quality engineering platform with the following proven capabilities:

1. **Test Generation (AI-powered)**  
   EXISTS in `src/mcp/tools/index.ts` as `qe/tests/generate` tool (SOURCE 1)

2. **Test Execution with Flaky Detection**  
   EXISTS in `src/mcp/tools/index.ts` as `qe/tests/execute` with parallel execution and retry logic (SOURCE 1)

3. **Coverage Analysis and Gap Detection**  
   EXISTS in `src/mcp/tools/index.ts` with both `qe/coverage/analyze` and `qe/coverage/gaps` tools using O(log n) HNSW algorithm (SOURCE 1)

4. **Security Scanning (SAST/DAST)**  
   EXISTS in `plugins/agentic-qe-fleet/agents/qe-security-scanner.md` with OWASP Top 10 scanning, dependency vulnerability checks via OSV API, and SARIF output (SOURCE 2)

5. **Code Intelligence Analysis**  
   EXISTS in `src/cli/commands/code.ts` for code understanding and `src/mcp/tools/index.ts` as `qe/code/analyze` tool (SOURCE 1, SOURCE 4)

6. **Multi-Agent Coherence Verification**  
   EXISTS in `src/integrations/coherence/coherence-service.ts` with Prime Radiant engines for reflex, retrieval, and escalation paths (SOURCE 7)

7. **Workflow and Pipeline Management**  
   EXISTS in `src/cli/commands/workflow.ts` implementing ADR-041 for QE workflows (SOURCE 5)

8. **Defect Prediction (ML-based)**  
   EXISTS in `src/mcp/tools/index.ts` as `qe/defects/predict` tool (SOURCE 1)

9. **Visual Regression Testing**  
   EXISTS in `src/mcp/tools/index.ts` as `qe/visual/compare` tool (SOURCE 1)

10. **Accessibility Auditing**  
    EXISTS in `src/mcp/tools/index.ts` as `qe/a11y/audit` tool (SOURCE 1)

11. **Chaos Engineering**  
    EXISTS in `src/mcp/tools/index.ts` as `qe/chaos/inject` tool (SOURCE 1)

12. **Token Usage Analysis**  
    EXISTS in `src/mcp/tools/index.ts` as `qe/analysis/token_usage` implementing ADR-042 (SOURCE 1)

13. **Plugin System for Extensions**  
    EXISTS in `src/plugins/index.ts` supporting local, GitHub, and npm plugin sources (SOURCE 6)

14. **Reinforcement Learning Orchestration**  
    EXISTS in `src/integrations/rl-suite/orchestrator.ts` for managing 10 RL algorithms (SOURCE 8)

Note: Container scanning and runtime application security testing (RAST) are explicitly NOT implemented per SOURCE 2.

## Core concepts & how they work

# Core Concepts & How They Work

## 1. Accessibility Testing Engine (`axe-core` Integration)
Agentic-qe provides **full WCAG compliance testing** through direct integration with `axe-core` (`src/domains/visual-accessibility/services/axe-core-integration.ts`). This includes:
- **WCAG 2.0/2.1/2.2 validation** with configurable rule sets (`src/domains/visual-accessibility/services/axe-core-audit.ts`)
- **Section 508 compliance checking** via mapped tag systems
- **Automated browser injection** through Vibium integration (`src/integrations/vibium/index.ts`)
- **Custom rule configuration** for domain-specific accessibility needs

## 2. Vibium Browser Automation
The system **natively supports browser automation** (`src/integrations/vibium/index.ts`) with:
- **Headless/headed browser control** (launch, navigation, termination)
- **Visual regression testing** via screenshot comparison
- **Element interaction** (clicks, typing, etc.) for E2E testing
- **Optional dependency model** that falls back gracefully when Vibium isn't available

## 3. Coherence Verification System
Agentic-qe implements **mathematical coherence gates** (`src/integrations/coherence/coherence-service.ts`) using six Prime Radiant engines:
1. **CohomologyEngine** - Detects logical contradictions via sheaf cohomology
2. **SpectralEngine** - Predicts system collapse through spectral analysis
3. **CausalEngine** - Identifies spurious correlations
4. **CategoryEngine** - Verifies type systems using category theory
5. **HomotopyEngine** - Provides formal verification via homotopy type theory
6. **WitnessEngine** - Maintains Blake3 cryptographic audit trails

The system routes decisions through **three compute lanes** (`src/integrations/coherence/index.ts`):
- **Reflex** (<1ms): Immediate execution for low-energy decisions
- **Retrieval** (~10ms): Context-aware decisions
- **Escalation**: Human-in-the-loop for high-energy scenarios

## 4. Agentic-Flow Capabilities
The system provides **WASM-accelerated code transformation** (`src/integrations/agentic-flow/index.ts`) including:
- **Mechanical code transforms** (352x faster than traditional methods)
- **Type system enhancements** (var-to-const, type addition)
- **Module system conversion** (CJS to ESM)
- **Pattern persistence** through ReasoningBank cross-session learning

## 5. Testability Scoring
Agentic-qe **quantifies requirement testability** (`src/domains/requirements-validation/services/testability-scorer.ts`) using weighted factors including:
- Requirement specificity
- Observable outcomes
- Technical feasibility
- Dependency complexity

## 6. Domain-Driven Architecture
The system follows **strict bounded contexts** (`src/index.ts`) with:
- 13 clearly separated domains
- Shared kernel for cross-domain types
- Coordination layer for inter-domain communication
- Hooks system for cross-phase integration

Each capability is implemented as shown in the cited source files, with no speculative features - the system delivers exactly what's documented in the implementation.

## Maturity (shipped vs proposed)

# Maturity (shipped vs proposed)

agentic-qe demonstrates high implementation maturity with 6 fully shipped ADRs and 2 accepted-but-not-yet-implemented proposals. The system delivers concrete production capabilities today while maintaining clear boundaries around future work.

## Shipped & Production-Ready Features

1. **Language-Specific Test Path Resolution** (EXISTS)  
   Implemented per ADR-079 (`docs/implementation/adrs/ADR-079-language-specific-test-file-path-resolution.md`). The `TestFileResolver` service handles 10+ language conventions with dedicated output paths verified by integration tests.

2. **Agent Memory Branching with RVF COW** (EXISTS)  
   Live in production per ADR-067 (`docs/implementation/adrs/ADR-067-agent-memory-branching-rvf-cow.md`). The `.rvf` file branching system provides isolated memory spaces with cryptographic merge provenance via `RvfDatabase.derive()`.

3. **Language-Aware Result Persistence** (EXISTS)  
   Operational per ADR-036 (`docs/implementation/adrs/ADR-036-result-persistence.md`). Saves outputs in tool-native formats (SARIF, LCOV) with historical tracking.

4. **Skill Validation System** (EXISTS)  
   Fully implemented per ADR-056 (`docs/implementation/adrs/ADR-056-skill-validation-system.md`). Three-tier validation (syntax, validator, evaluation suite) with regression detection.

5. **StrongDM Software Factory** (EXISTS)  
   Core components shipped per ADR-062 (`docs/implementation/adrs/ADR-062-strongdm-software-factory.md`). Includes token tracking dashboard and holdout test generation.

6. **Proof-Gate Memory Integrity** (EXISTS)  
   Live protection per ADR-116 (`docs/implementation/adrs/ADR-116-proof-gate-memory-integrity.md`). The `HashChainGate` TS port provides cryptographic write verification in `src/integrations/ruvector/proof-gate.ts`.

## Accepted But Not Yet Implemented

1. **Learning Routing Hardening**  
   ADR-098 (`docs/implementation/adrs/ADR-098-learning-routing-hardening.md`) is accepted but pending implementation of domain-score de-dilution and pattern-store improvements.

2. **Opus 4.7 Integration**  
   ADR-093 (`docs/implementation/plans/ADR-093-IMPLEMENTATION-PLAN.md`) outlines the migration plan but remains in progress per the staged PR rollout.

No features are proposed without either shipped implementations or explicit ADR acceptance. The codebase maintains rigorous traceability between decisions and their concrete realizations.

## Where the documentation lives

The documentation for agentic-qe is meticulously organized across several directories and files, each serving a specific purpose. Here's where everything lives:

### Core Documentation
- **Introduction and Architecture**: The foundational overview of agentic-qe, including its architecture and key components, is documented in `docs/agentic-qe-intro.md`. This file provides a high-level technical introduction and details the five-layer architecture.
- **Agent Catalog**: The complete catalog of agents and their skills is maintained in `docs/catalogs/AGENTIC-QE-AGENT-CATALOG.md`. This document lists all 63+ agents across 12 domains and their associated skills.

### Architectural Decisions
- **ADRs**: Architecture Decision Records (ADRs) for agentic-qe v3 are stored in `docs/implementation/adrs/v3-adrs.md`. This file contains detailed records of architectural decisions, their status, and implementation details.

### Plans and Roadmaps
- **GOAP Integration Plan**: The Goal-Oriented Action Planning (GOAP) integration plan is documented in `docs/plans/goap-agentic-qe-integration-2025.md`. This file outlines the integration points and current state analysis for GOAP implementation.
- **V3 Improvements Plan**: The plan for v3 improvements is detailed in `docs/plans/AQE_V3_IMPROVEMENTS_PLAN.md`. This document includes specific improvement tasks and their implementation status.

### Reports and Summaries
- **Queen Coordination Summary**: The coordination summary for the Queen agent is available in `docs/qe-reports-3-7-0/00-queen-coordination-summary.md`. This report provides insights into agent coordination and performance metrics.

### Contribution and Security
- **Contribution Guidelines**: Guidelines for contributing to the project are outlined in `CONTRIBUTING.md`. This file covers the PR process, review criteria, and testing guidelines.
- **Security Practices**: Security practices and procedures are documented in `SECURITY.md`. This file includes information on reporting vulnerabilities and security contacts.

Each of these documents is essential for understanding and working with agentic-qe, providing a comprehensive view of its architecture, agents, plans, and processes.

## How to use it end-to-end

### How to use it end-to-end

#### Installation
1. **Install the package**: Run `npm install agentic-qe` in your project. The preinstall script (`scripts/preinstall.cjs`) will handle any conflicts with previous versions automatically.  
2. **Post-install setup**: The postinstall script (`scripts/postinstall.cjs`) ensures all dependencies are correctly installed. No additional setup is required as dependencies are flattened into the root `package.json`.  

#### Configuration
1. **Initialize OpenCode agents**: The installer (`src/init/opencode-installer.ts`) automatically configures OpenCode agents in your project. Agents are installed in `.opencode/agents/` (e.g., `qe-test-generator.yaml` and `qe-quality-criteria-recommender.yaml`).  
2. **Verify MCP server**: Ensure the Model Context Protocol (MCP) server is running by checking `opencode.json` in your project root.  

#### Usage
1. **Run agents**: Use the CLI or MCP server to execute agents. For example, to generate tests, invoke the `qe-test-generator` agent (`.opencode/agents/qe-test-generator.yaml`). It supports multi-framework test generation (Jest, Vitest, Mocha, etc.) and integrates with the ReasoningBank for pattern reuse.  
2. **Quality criteria analysis**: Use the `qe-quality-criteria-recommender` agent (`.opencode/agents/qe-quality-criteria-recommender.yaml`) to analyze project documentation and recommend quality criteria based on HTSM v6.3.  
3. **Monitor agent execution**: Agent outputs are stored in `.agentic-qe/agents/` (e.g., `agent-1767445182612-07612d17111cd44b9a.json`).  

#### Advanced Features
1. **GOAP integration**: Dynamic planning is implemented for quality gate decisions and test strategy generation (`docs/plans/goap-agentic-qe-integration-2025.md`).  
2. **Learning system**: Agents automatically capture and reuse patterns via the ReasoningBank (`docs/agentic-qe-intro.md`).  

#### Troubleshooting
- **Conflict resolution**: If installation fails, check the preinstall script (`scripts/preinstall.cjs`) for conflicts with older versions.  
- **Agent logs**: Review agent outputs in `.agentic-qe/agents/` for detailed execution logs.  

This end-to-end guide ensures you can install, configure, and use agentic-qe effectively in your projects.
