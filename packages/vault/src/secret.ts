const REDACTED = "[redacted]";

/**
 * A secret value that refuses to print itself. `String(secret)`, template
 * strings, `JSON.stringify`, and `console.log`/`util.inspect` all show
 * `[redacted]`. Code that needs the value must call `reveal()`, which is easy
 * to search for in review.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
