export type ProviderFactory<T> = () => T;

export interface ProviderRegistry<T> {
  register(name: string, factory: ProviderFactory<T>): void;
  get(name: string): T;
  has(name: string): boolean;
  names(): string[];
}

export function createRegistry<T>(kind: string): ProviderRegistry<T> {
  const factories = new Map<string, ProviderFactory<T>>();

  return {
    register(name, factory) {
      factories.set(name, factory);
    },
    get(name) {
      const factory = factories.get(name);
      if (!factory) {
        const available = [...factories.keys()].join(", ");
        throw new Error(`Unknown ${kind} provider "${name}". Available: ${available}`);
      }
      return factory();
    },
    has(name) {
      return factories.has(name);
    },
    names() {
      return [...factories.keys()];
    },
  };
}
