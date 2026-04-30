import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PaneBody } from "./Pane";
import styles from "./Pane.module.css";

describe("PaneBody", () => {
  afterEach(() => cleanup());

  it("renders children inside a div with the body class", () => {
    const { getByText, container } = render(<PaneBody>hello</PaneBody>);
    expect(getByText("hello")).toBeTruthy();
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains(styles.body)).toBe(true);
    expect(root.classList.contains(styles.flush)).toBe(false);
  });

  it("adds the flush class when flush is true", () => {
    const { container } = render(<PaneBody flush>hi</PaneBody>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains(styles.body)).toBe(true);
    expect(root.classList.contains(styles.flush)).toBe(true);
  });

  it("forwards arbitrary HTML attributes (e.g. hidden)", () => {
    const { container } = render(<PaneBody hidden>x</PaneBody>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.hidden).toBe(true);
  });

  it("merges an additional className with the body class", () => {
    const { container } = render(
      <PaneBody className="extra">x</PaneBody>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains(styles.body)).toBe(true);
    expect(root.classList.contains("extra")).toBe(true);
  });
});
