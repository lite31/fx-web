import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
const app = new App({ name: "controlled-chart", version: "1" }, {});
const dataSchema = z.object({ sales: z.array(z.number()).length(3) });
const select = document.querySelector("#period");
const summary = document.querySelector("#summary");
const line = document.querySelector("#line");
if (!(select instanceof HTMLSelectElement) || !summary || !line)
  throw new Error("Chart elements missing.");
function draw(data: unknown) {
  const { sales } = dataSchema.parse(data);
  if (summary) summary.textContent = sales.join(", ");
  line?.setAttribute(
    "d",
    sales
      .map((value, index) => (index ? "L" : "M") + (10 + index * 40) + " " + (75 - value))
      .join(" "),
  );
}
app.ontoolinput = () => {};
app.ontoolresult = (result) => draw(result.structuredContent);
select.onchange = async () => {
  select.disabled = true;
  try {
    const result = await app.callServerTool({
      name: "filter_chart",
      arguments: { period: select.value },
    });
    draw(result.structuredContent);
  } finally {
    select.disabled = false;
  }
};
await app.connect(new PostMessageTransport(window.parent, window.parent));
select.disabled = false;
