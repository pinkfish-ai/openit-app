import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "link"
  | "destructive"
  | "cmdk";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders the button as a square icon-only control. */
  iconOnly?: boolean;
  children?: ReactNode;
}

/** One Button. Five variants × three sizes × icon-only modifier.
 *  Replaces the 20+ button classes catalogued in the v5 audit. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", size = "md", iconOnly = false, className, type, ...rest },
    ref,
  ) {
    const cls = [
      styles.btn,
      styles[size],
      styles[variant],
      iconOnly && styles.icon,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return <button ref={ref} type={type ?? "button"} className={cls} {...rest} />;
  },
);
