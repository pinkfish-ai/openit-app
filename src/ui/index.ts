/** OpenIT design system — primitives barrel.
 *
 * Spec: auto-dev/design-explorations/2026-04-29-shell-chrome/v5/index.html
 * Plan: auto-dev/plans/2026-04-29-design-system-v5-foundation.md
 *
 * Token reference: src/styles/tokens.css
 */

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { Chip } from "./Chip";
export type { ChipProps, ChipVariant } from "./Chip";

export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";

export { Banner } from "./Banner";
export type { BannerProps, BannerVariant } from "./Banner";

export { ToastProvider, useToast } from "./Toast";
export type { ToastInput, ToastTone } from "./Toast";

export { Input, TextArea, Field } from "./Input";
export type { InputProps, InputSize, TextAreaProps, FieldProps } from "./Input";

export { Modal } from "./Modal";
export type { ModalProps, ModalSize } from "./Modal";

export { Pane, SectionBar, SectionBarSpacer, PaneBody } from "./Pane";
export type { PaneProps, SectionBarProps, PaneBodyProps } from "./Pane";

export { Wordmark } from "./Wordmark";
export type { WordmarkProps } from "./Wordmark";

export { TitleRail, TitleRailContext, TitleRailItem } from "./TitleRail";
export type { TitleRailProps, TitleRailContextProps } from "./TitleRail";
