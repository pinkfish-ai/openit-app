import styles from "./Wordmark.module.css";

export interface WordmarkProps {
  /** When false, the tagline is hidden — useful in narrow contexts. */
  showTagline?: boolean;
  className?: string;
}

/** OpenIT wordmark with italic serif "I" + serif tagline.
 *  Replaces the .wordmark/.app-title/.app-tagline triplet in App.css. */
export function Wordmark({ showTagline = true, className }: WordmarkProps) {
  const cls = [styles.mark, className].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      <span className={styles.name}>
        Open<em>I</em>T
      </span>
      {showTagline ? (
        <>
          <span className={styles.sep} aria-hidden>
            ·
          </span>
          <span className={styles.tag}>get IT done</span>
        </>
      ) : null}
    </span>
  );
}
