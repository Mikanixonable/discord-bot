// @ipld/car と @ipld/dag-cbor は .d.ts を持つが、NodeNext moduleResolution で
// exports マップの解決に失敗する場合があるため、最低限の型宣言を提供する。

declare module "@ipld/car" {
  interface Block {
    cid: { toString(): string };
    bytes: Uint8Array;
  }

  export class CarReader {
    static fromBytes(bytes: Uint8Array): Promise<CarReader>;
    static fromIterable(iterable: AsyncIterable<Uint8Array>): Promise<CarReader>;
    getRoots(): Promise<Array<{ toString(): string }>>;
    blocks(): AsyncIterable<Block>;
  }
}

declare module "@ipld/dag-cbor" {
  export function decode(bytes: Uint8Array): unknown;
  export function encode(value: unknown): Uint8Array;
}
