import { formatRupiah, parseRupiah } from "@sales-visit/contracts";
import type { ComponentProps } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

export function RupiahInput({
  value,
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof InputGroupInput>, "onChange" | "value"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <InputGroup>
      <InputGroupAddon>Rp</InputGroupAddon>
      <InputGroupInput
        {...props}
        value={value}
        inputMode="numeric"
        onChange={(event) => {
          const control = event.currentTarget;
          const raw = control.value;
          const native = event.nativeEvent as InputEvent;
          const editingDigits =
            (native.inputType === "insertText" &&
              /^[0-9]+$/.test(native.data ?? "")) ||
            native.inputType?.startsWith("delete");
          const previousValid = parseRupiah(value) !== undefined;
          // Pasted text always goes through the strict parser. Only regroup digit
          // edits of an already valid displayed amount; never strip arbitrary input.
          const amount = parseRupiah(
            editingDigits && previousValid && /^[0-9. ]*$/.test(raw)
              ? raw.replace(/[. ]/g, "")
              : raw
          );
          if (amount === undefined) {
            onValueChange(raw);
            return;
          }
          const digits = raw
            .slice(0, control.selectionStart ?? raw.length)
            .replace(/[^0-9]/g, "").length;
          const formatted = formatRupiah(amount).replace(/^Rp /, "");
          onValueChange(formatted);
          requestAnimationFrame(() => {
            let position = 0,
              count = 0;
            while (position < formatted.length && count < digits) {
              if (/[0-9]/.test(formatted[position]!)) count++;
              position++;
            }
            if (document.activeElement === control)
              control.setSelectionRange(position, position);
          });
        }}
      />
    </InputGroup>
  );
}
