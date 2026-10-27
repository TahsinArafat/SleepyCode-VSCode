/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Barrel for the settings feature panels. Each panel lives in ./panels/*;
// this file preserves the historical import surface used by App.tsx.
//
// `ProvidersPanel` and `ModelsPanel` are gone: a barrel export made them look
// live while nothing rendered them, and this build serves those screens from
// `ProviderKeysPanel` and `ModelOptionsPanel`. Re-exporting a component nothing
// renders is how a dead screen keeps its CSS alive for years.
export { OAuthAccountCard } from "./panels/OAuthAccountCard";
export { McpPanel } from "./panels/McpPanel";
export { RulesPanel } from "./panels/RulesPanel";
export { SubagentsPanel } from "./panels/SubagentsPanel";
export { HooksPanel } from "./panels/HooksPanel";
export { LlamacppPanel } from "./panels/LlamacppPanel";
export { OllamaPanel } from "./panels/OllamaPanel";