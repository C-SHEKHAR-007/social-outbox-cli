/** An error whose message is safe and useful to show the user directly. */
export class UserError extends Error {
  override readonly name: string = 'UserError';
}

export class ConfigError extends UserError {
  override readonly name = 'ConfigError';
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}
