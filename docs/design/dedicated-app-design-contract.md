# Dedicated App Design Contract

## Status

Claude Design export is not present yet.

This document defines the production contract that the Claude Design output must be translated into after export.

The current document is a scaffold. Update it after adding Claude Design files under:

```txt
docs/design/claude-design/
```

## Product identity

Cat Code dedicated app should feel:

* local-first
* technical
* durable
* calm
* serious but not boring
* agent-runtime focused
* clear about what is real vs placeholder
* not a generic SaaS dashboard
* not a toy chat app

## Existing product reality

Cat Code is currently primarily a terminal coding agent.

The dedicated app should become a richer app surface around the same local-first agent runtime, not a separate unrelated product.

The current app surface is scaffold/placeholder work. It must not pretend that real runtime integration exists before it does.

## Target implementation area

Production UI belongs in:

```txt
src/dedicated-app/
```

Shared app-facing state and runtime contracts belong in:

```txt
src/app-runtime/
```

Do not use root `web/` for this migration path unless explicitly using it as historical reference.

## Existing boundary rule

The app-runtime layer should not import:

* React
* Ink
* terminal screens
* terminal components
* root web code

The dedicated-app layer may import React, but should not import:

* Ink
* terminal screens
* terminal components
* root web code

## Main layout hypothesis

To be confirmed after Claude Design export.

Likely layout:

* left sidebar: workspace, projects, sessions, lanes
* center: active session, chat, task execution, or run surface
* right panel: permissions, files, agents, runtime status, settings, account/status surfaces
* top/status area: current goal, runtime health, active mode

## Required screens

To confirm from Claude Design:

* dedicated app home
* active session
* task/run view
* permission approval
* file changes / diff view
* agents/workers view
* runtime status
* settings
* account/provider status
* empty state
* loading state
* error state
* disconnected/runtime-not-ready state

## Design tokens

TODO after Claude Design export:

* background colors
* surface colors
* elevated surface colors
* text colors
* muted text colors
* accent colors
* warning colors
* danger colors
* border colors
* spacing scale
* radius scale
* shadow style
* typography
* animation timing

## Interaction rules

* Long-running actions must show progress.
* Dangerous actions need explicit approval.
* Runtime-not-ready state must be honest.
* Placeholder state must not pretend to be real.
* User should always understand what the agent is doing.
* The app should not depend on raw terminal text for core UI.
* Browser/app shell should call controller actions only when actions are actually ready.
* Permission requests should be visible and explicit.
* Runtime errors should not be hidden.
* Disabled actions should explain or imply why they are disabled.
* The CLI must keep working independently.

## Preserve from Claude Design

TODO after export.

Use this section to document:

* visual mood
* layout decisions
* color direction
* important component shapes
* important spacing/scale choices
* important interactions
* microcopy that should stay

## Safe to change during productionization

The production implementation may change:

* generated HTML structure
* messy inline CSS
* duplicated visual styles
* fake data
* prototype-only interactions
* inconsistent spacing values
* inconsistent color values
* one-off components
* inaccessible markup

## Do not do

* do not paste exported Claude Design HTML directly as final app
* do not create one giant component
* do not duplicate button/card/dialog/sidebar styles
* do not connect real terminal app logic in this phase
* do not break current CLI behavior
* do not import terminal UI into dedicated app
* do not import React into `src/app-runtime/`
* do not create a new root `web/` app
* do not claim placeholder data is real runtime state
