declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: Array<string | number | bigint | Uint8Array | null>): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(...params: Array<string | number | bigint | Uint8Array | null>): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    all(...params: Array<string | number | bigint | Uint8Array | null>): any[];
  }

  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
