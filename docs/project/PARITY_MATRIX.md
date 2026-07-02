# TMM Parity Matrix (Legacy → Vite/React/Tailwind)

This matrix maps the parity spec headings to legacy modules and current React/Vite implementation status, plus the target implementation locations.

## Boot & Readiness Gates
- Legacy: `uxOrchestrator.js`, `auth.js`, `auth-ui.js`, `splash.html`, `index.html`
- Current: `frontend/src/state/flowState.ts`, `frontend/src/app/AppShell.tsx`
- Status: Implemented; overlay order and restore gating aligned
- Target: `frontend/src/app/AppShell.tsx`, `frontend/src/state/flowState.ts`

## Authentication & Identity
- Legacy: `auth.js`, `auth-ui.js`, `auth-wiring.js`, `splash.html`, `auth-callback.html`
- Current: `frontend/src/app/providers/AuthProvider.tsx`, `frontend/src/components/overlays/AuthScreen.tsx`, `frontend/src/components/overlays/SplashScreen.tsx`
- Status: Implemented; splash experience restored + Google auth CTA
- Target: `frontend/src/components/overlays/*`

## Integration Parity (Google Sheets)
- Legacy: `sheets.js`, `oauth.js`
- Current: `frontend/src/lib/sheets/*`, `frontend/src/features/integrations/sheets/index.ts`, `backend/server.js`
- Status: Implemented; schema parity, bidirectional sync, offline queue
- Target: `frontend/src/lib/sheets/*`, `backend/server.js`

## Restore Session Logic
- Legacy: `persistence.js`, `ux/restoreSessionService.js`
- Current: `frontend/src/lib/plan/planPersistence.ts`, `frontend/src/features/restore/*`
- Status: Implemented; native plan hydration and decline tracking
- Target: `frontend/src/features/restore/*`

## Onboarding & Tour Orchestration
- Legacy: `onboardingState.js`, `onboardingSurvey.js`, `onboardingPathBuilder.js`, `adaptiveTour.js`, `uxOrchestrator.js`
- Current: `frontend/src/features/onboarding/*`, `frontend/src/components/overlays/OnboardingOverlay.tsx`, `frontend/src/components/overlays/TourOverlay.tsx`
- Status: Implemented; adaptive survey + tour step pathing
- Target: `frontend/src/features/onboarding/*`

## Navigation & Screens
- Legacy: `index.html`, `ui.js`
- Current: `frontend/src/app/routing.ts`, `frontend/src/app/AppShell.tsx`
- Status: Routes exist; UI incomplete
- Target: Screen-specific React features under `frontend/src/features/*`

## Core Data Model
- Legacy: `state.js`
- Current: `frontend/src/lib/plan/types.ts`, `frontend/src/lib/plan/planStore.ts`
- Status: Implemented unified PlanStore
- Target: `frontend/src/lib/plan/*`

## Editing Workflows
- Legacy: `ui.js` (tables and editing)
- Current: `frontend/src/features/accounts/*`, `frontend/src/features/goals/*`, `frontend/src/features/settings/*`
- Status: Implemented; PlanStore wired across screens
- Target: React features wired to PlanStore; derived recompute hooks

## Alternatives & Scenarios
- Legacy: `state.js`, `ui.js` alt toggles
- Current: `frontend/src/features/alternatives/AlternativesPanel.tsx`, `frontend/src/lib/plan/planStore.ts`
- Status: Implemented; switching + chart toggles + colors
- Target: `frontend/src/features/alternatives/*`

## Simulation Engine
- Legacy: `simulation.js`, `augments.js`, `checkpoints.js`, `varianceDetector.js`
- Current: `frontend/src/lib/simulation/*`
- Status: Implemented; parity edge cases + checkpoints + augments
- Target: `frontend/src/lib/simulation/*`

## Pipeline Builder
- Legacy: `pipelineBuilder.js`
- Current: `frontend/src/features/pipeline/PipelineCanvas.tsx`
- Status: Implemented; drag-connect + layout + flows
- Target: `frontend/src/features/pipeline/*`

## Charts & Insights
- Legacy: `ui.js` (drawChartMulti, renderAssetPie, renderCashflowChart)
- Current: `frontend/src/components/charts/*`, `frontend/src/features/dashboard/*`
- Status: Implemented; canvas charts + slider + tooltip
- Target: `frontend/src/components/charts/*`

## Persistence & Sync
- Legacy: `persistence.js`, `sheets.js`
- Current: `frontend/src/lib/plan/planPersistence.ts`, `frontend/src/lib/sheets/*`, `frontend/src/lib/plan/xlsx.ts`
- Status: Implemented; restore prompts, Sheets sync, XLSX import/export
- Target: `frontend/src/lib/plan/*`, `frontend/src/lib/sheets/*`

## UX Polish & Performance
- Legacy: `ui.js` event handling, debounced draw
- Current: chart throttling, loading/disabled states, queue status
- Status: Implemented; verify in manual runbook
- Target: verify in `docs/project/PARITY_VERIFICATION.md`

