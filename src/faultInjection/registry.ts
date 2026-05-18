import type { FaultScenario } from "./types.js";
import { BUILT_IN_SCENARIOS } from "./scenarios.js";

export class ScenarioRegistry {
  private scenarios = new Map<string, FaultScenario>();

  constructor(seedDefaults = true) {
    if (seedDefaults) {
      for (const s of BUILT_IN_SCENARIOS) {
        this.scenarios.set(s.id, s);
      }
    }
  }

  register(scenario: FaultScenario): void {
    this.scenarios.set(scenario.id, scenario);
  }

  get(id: string): FaultScenario | undefined {
    return this.scenarios.get(id);
  }

  getAll(): FaultScenario[] {
    return [...this.scenarios.values()];
  }

  findByCategory(category: FaultScenario["category"]): FaultScenario[] {
    return this.getAll().filter((s) => s.category === category);
  }

  findBySeverity(severity: FaultScenario["severity"]): FaultScenario[] {
    return this.getAll().filter((s) => s.severity === severity);
  }

  findByTag(tag: string): FaultScenario[] {
    return this.getAll().filter((s) => s.tags?.includes(tag));
  }

  size(): number {
    return this.scenarios.size;
  }

  toJSON(): FaultScenario[] {
    return this.getAll();
  }

  static fromJSON(scenarios: FaultScenario[]): ScenarioRegistry {
    const registry = new ScenarioRegistry(false);
    for (const s of scenarios) {
      registry.register(s);
    }
    return registry;
  }
}

export function createDefaultRegistry(): ScenarioRegistry {
  return new ScenarioRegistry(true);
}
