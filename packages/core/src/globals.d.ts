// `core` compiles without Node or DOM types so that I/O APIs (fs, net, fetch, timers)
// are a type error here. These are the only platform globals core may use: pure,
// deterministic, available in every JS runtime we target.

declare class URL {
  constructor(input: string, base?: string | URL);
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly origin: string;
  readonly href: string;
  toString(): string;
  static canParse(input: string, base?: string): boolean;
}
