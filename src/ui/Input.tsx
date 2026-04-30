import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";
import styles from "./Input.module.css";

export type InputSize = "sm" | "md" | "lg";

interface CommonProps {
  size?: InputSize;
  hasError?: boolean;
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
    CommonProps {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", hasError, className, ...rest },
  ref,
) {
  const cls = [
    styles.input,
    size === "sm" && styles.sm,
    size === "lg" && styles.lg,
    hasError && styles.error,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <input ref={ref} className={cls} {...rest} />;
});

export interface TextAreaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    Pick<CommonProps, "hasError"> {}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea({ hasError, className, ...rest }, ref) {
    const cls = [styles.input, hasError && styles.error, className]
      .filter(Boolean)
      .join(" ");
    return <textarea ref={ref} className={cls} {...rest} />;
  },
);

export interface FieldProps {
  label?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** Label + control + help/error wrapper. Use with <Input> or <TextArea>. */
export function Field({ label, help, error, htmlFor, children, className }: FieldProps) {
  const cls = [styles.field, className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {label ? (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <div className={styles.errorText} role="alert">
          {error}
        </div>
      ) : help ? (
        <div className={styles.help}>{help}</div>
      ) : null}
    </div>
  );
}
