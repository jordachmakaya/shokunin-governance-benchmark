export interface NDJsonReadOptions {
  readonly maxLineLengthBytes?: number;
  readonly ignoreEmptyLines?: boolean;
  readonly allowMissingFile?: boolean;
}

export interface INDJsonStore<T> {
  append(filePath: string, record: T): Promise<void>;
  appendBatch(filePath: string, records: readonly T[]): Promise<void>;
  readAll(filePath: string, options?: NDJsonReadOptions): Promise<readonly T[]>;
  streamAll(filePath: string, options?: NDJsonReadOptions): AsyncIterable<T>;
}
