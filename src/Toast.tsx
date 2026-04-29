// The canonical Toast lives in src/ui/Toast.tsx. This file is kept
// as a re-export so existing imports (`./Toast` / `../Toast`) keep
// working through the migration. Prefer importing directly from
// `./ui` in new code.
//
// The previous implementation here (and the now-deleted
// src/shell/Toast.tsx that duplicated the idea with different
// timing) has been folded into the unified src/ui/Toast.

export { ToastProvider, useToast } from "./ui/Toast";
export type { ToastInput, ToastTone } from "./ui/Toast";
