/**
 * Orientation for someone who has just arrived.
 *
 * The page shows three panels doing three different jobs, and without a
 * sentence of framing it is not obvious which one to look at first or that the
 * middle one is editable at all. Three steps, in the order a visitor should
 * take them.
 */
export function HowTo() {
  return (
    <ol className="how-to" aria-label="How to use this page">
      <li>
        <span className="how-to-step" aria-hidden="true">
          1
        </span>
        <div>
          <strong>Pick a sample prompt</strong>
          <p>Choose one of the example descriptions and press Generate.</p>
        </div>
      </li>
      <li>
        <span className="how-to-step" aria-hidden="true">
          2
        </span>
        <div>
          <strong>Watch the model get built</strong>
          <p>Each tool call appears as it happens, including any the validator rejects.</p>
        </div>
      </li>
      <li>
        <span className="how-to-step" aria-hidden="true">
          3
        </span>
        <div>
          <strong>Edit it, or just use the app</strong>
          <p>Change the JSON and the application follows, or interact with the result directly.</p>
        </div>
      </li>
    </ol>
  );
}
