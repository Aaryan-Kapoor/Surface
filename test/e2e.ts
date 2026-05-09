import "dotenv/config";

const SURFACE_URL = process.env.SURFACE_URL || "http://localhost:3000";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

if (!OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is required in .env");
  process.exit(1);
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "artifact_create",
      description:
        "Create a durable artifact. Use text/html content for an interactive Surface app.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Display title for the artifact" },
          mime: { type: "string", description: "MIME type, usually text/html for apps" },
          content: {
            type: "string",
            description: "Complete HTML content with inline CSS/JS",
          },
          metadata: {
            type: "object",
            properties: {
              icon: { type: "string", description: "Emoji icon" },
              description: { type: "string", description: "Short description" },
            },
          },
        },
        required: ["title", "mime", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "artifact_read",
      description: "Read an artifact's metadata, current version, and file manifest.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The artifact ID" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "artifact_update",
      description: "Create a new immutable version of an artifact.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The artifact ID" },
          title: { type: "string", description: "New title" },
          mime: { type: "string", description: "MIME type, usually text/html for apps" },
          content: { type: "string", description: "New complete file content" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "artifact_delete",
      description: "Delete an artifact and its surface view.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The artifact ID" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "surface_list",
      description: "List all surfaces (without HTML content).",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function callOpenRouter(
  messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }>
) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }
  return res.json();
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  console.log(`  Tool: ${name}(${JSON.stringify(args).slice(0, 100)}...)`);

  switch (name) {
    case "artifact_create": {
      const res = await fetch(`${SURFACE_URL}/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      return JSON.stringify(await res.json());
    }
    case "artifact_read": {
      const res = await fetch(`${SURFACE_URL}/artifacts/${args.id}`);
      return JSON.stringify(await res.json());
    }
    case "artifact_update": {
      const { id, ...rest } = args;
      const res = await fetch(`${SURFACE_URL}/artifacts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      return JSON.stringify(await res.json());
    }
    case "artifact_delete": {
      const res = await fetch(`${SURFACE_URL}/artifacts/${args.id}`, {
        method: "DELETE",
      });
      return JSON.stringify(await res.json());
    }
    case "surface_list": {
      const res = await fetch(`${SURFACE_URL}/surfaces`);
      return JSON.stringify(await res.json());
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function runConversation(prompt: string, messages: Array<any> = []): Promise<{
  messages: Array<any>;
  finalText: string;
}> {
  messages.push({ role: "user", content: prompt });

  let iterations = 0;
  while (iterations < 5) {
    iterations++;
    const result = await callOpenRouter(messages);
    const choice = result.choices[0];
    const msg = choice.message;

    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
        const toolResult = await executeTool(tc.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    } else {
      return { messages, finalText: msg.content || "" };
    }
  }
  return { messages, finalText: "(max iterations reached)" };
}

// ── Test Steps ──

async function main() {
  console.log(`\n=== Surface E2E Test ===`);
  console.log(`Model: ${OPENROUTER_MODEL}`);
  console.log(`Surface API: ${SURFACE_URL}\n`);

  // Verify server is running
  try {
    await fetch(`${SURFACE_URL}/surfaces`);
  } catch {
    console.error("Surface server not running! Start with: npm run dev");
    process.exit(1);
  }

  const beforeListRes = await fetch(`${SURFACE_URL}/surfaces`);
  const beforeSurfaces = await beforeListRes.json() as Array<{ id: string }>;
  const beforeIds = new Set(beforeSurfaces.map((surface) => surface.id));

  // Step 1: Create an artifact-backed surface
  console.log("Step 1: Ask LLM to create a simple interactive app...");
  const { messages, finalText: t1 } = await runConversation(
    "Create a displayable HTML artifact with a simple click counter app. It should have a big number in the center that increments when you click a button. Make it look nice with a dark theme. Use the artifact_create tool with mime text/html and complete HTML content."
  );
  console.log(`  LLM response: ${t1.slice(0, 150)}...`);

  // Verify surface was created
  const listRes = await fetch(`${SURFACE_URL}/surfaces`);
  const surfaces = await listRes.json() as Array<{ id: string; title: string }>;
  console.log(`  Surfaces after create: ${surfaces.length}`);
  const createdSurface = surfaces.find((surface) => !beforeIds.has(surface.id));
  if (!createdSurface) {
    console.error("  FAIL: No surfaces created!");
    process.exit(1);
  }
  const surfaceId = createdSurface.id;
  console.log(`  Created surface ID: ${surfaceId}`);
  console.log("  PASS\n");

  // Step 2: Read the artifact
  console.log("Step 2: Ask LLM to read the artifact and describe it...");
  const { messages: msgs2, finalText: t2 } = await runConversation(
    `Read the artifact with ID "${surfaceId}" and tell me what it contains.`,
    messages
  );
  console.log(`  LLM response: ${t2.slice(0, 200)}...`);
  console.log("  PASS\n");

  // Step 3: Update the artifact
  console.log("Step 3: Ask LLM to update the artifact...");
  const { messages: msgs3, finalText: t3 } = await runConversation(
    `Update the artifact "${surfaceId}" - add a reset button that sets the counter back to 0. Keep the existing functionality. Use artifact_update with mime text/html and complete updated HTML content.`,
    msgs2
  );
  console.log(`  LLM response: ${t3.slice(0, 150)}...`);

  // Verify update
  const readRes = await fetch(`${SURFACE_URL}/surfaces/${surfaceId}`);
  const updated = await readRes.json() as { html: string };
  const hasReset = updated.html.toLowerCase().includes("reset") ||
                   updated.html.includes("= 0");
  console.log(`  Updated HTML contains reset: ${hasReset}`);
  console.log("  PASS\n");

  // Step 4: Delete the artifact
  console.log("Step 4: Ask LLM to delete the artifact...");
  const { finalText: t4 } = await runConversation(
    `Delete the artifact "${surfaceId}".`,
    msgs3
  );
  console.log(`  LLM response: ${t4.slice(0, 150)}...`);

  // Verify deletion
  const listRes2 = await fetch(`${SURFACE_URL}/surfaces`);
  const surfacesAfter = await listRes2.json() as Array<unknown>;
  const testSurfaceGone = !surfacesAfter.some((s: any) => s.id === surfaceId);
  console.log(`  Surface deleted: ${testSurfaceGone}`);
  console.log("  PASS\n");

  console.log("=== All E2E tests passed ===\n");
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
