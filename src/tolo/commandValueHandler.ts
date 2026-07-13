// Ported from tololib/command_value_handler.py.
//
// A CommandValueHandler knows how to convert a single command value between its
// native representation and the single byte carried on the wire. Python inferred
// the native type via runtime generic reflection (`__orig_class__`); TypeScript
// has no such thing at runtime, so we carry an explicit `kind`:
//
//   - 'bool': byte -> boolean (any non-zero byte is true)
//   - 'int' : byte -> number  (also used for IntEnum values, which are plain
//             numbers in TS)
//
// `noneEquivalent`, when set, is the sentinel byte value that maps to/from
// `null` (e.g. 0xff meaning "power timer disabled").

export type ValueKind = 'bool' | 'int';

/** A native command value: a boolean, a number (incl. enum members), or null. */
export type NativeValue = boolean | number | null;

function assertByte(byteValue: number): void {
  if (!Number.isInteger(byteValue) || byteValue < 0 || byteValue > 255) {
    throw new Error('given value is not a single byte');
  }
}

export class CommandValueHandler {
  constructor(
    private readonly kind: ValueKind,
    private readonly validatorFunction?: (x: number) => boolean,
    private readonly noneEquivalent?: number,
  ) {
    if (noneEquivalent !== undefined) assertByte(noneEquivalent);
  }

  byte2native(byteValue: number): NativeValue {
    assertByte(byteValue);

    if (this.noneEquivalent !== undefined && byteValue === this.noneEquivalent) {
      return null;
    }

    return this.kind === 'bool' ? byteValue !== 0 : byteValue;
  }

  native2byte(nativeValue: NativeValue): number {
    if (nativeValue === null) {
      if (this.noneEquivalent !== undefined) return this.noneEquivalent;
      throw new Error('None not a supported value');
    }

    if (!this.validateNativeValue(nativeValue)) {
      throw new Error('value not allowed by validator function');
    }

    if (typeof nativeValue === 'boolean') return nativeValue ? 0x01 : 0x00;
    if (typeof nativeValue === 'number') {
      assertByte(nativeValue);
      return nativeValue;
    }
    throw new Error(`not a supported value type: ${typeof nativeValue}`);
  }

  private validateNativeValue(nativeValue: boolean | number): boolean {
    if (this.validatorFunction === undefined) return true;
    // Validators are only ever attached to numeric commands.
    return this.validatorFunction(nativeValue as number);
  }
}
