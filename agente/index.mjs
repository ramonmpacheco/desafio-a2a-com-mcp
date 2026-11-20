import http from "node:http";
import crypto from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  specTypeSchemas,
  withInputRequired,
  isInputRequiredResult,
  ProtocolError,
} from "@modelcontextprotocol/client";

const AGENTE_PORT = Number(
  process.env.AGENTE_PORT || process.env.PORT || 7300
);
const AGENTE_PATH = process.env.AGENTE_PATH || "/a2a";
const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:7301/mcp";

const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_FAILED",
]);

function randomHex(bytes = 6) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Propaga o mesmo trace-id do traceparent recebido do cliente A2A,
 * gerando um novo span-id para a chamada MCP.
 */
function propagarTraceparent(traceparent) {
  if (!traceparent || typeof traceparent !== "string") return undefined;
  const partes = traceparent.trim().split("-");
  if (partes.length === 4 && partes[1].length === 32) {
    const version = partes[0];
    const traceId = partes[1];
    const flags = partes[3];
    const novoSpanId = randomHex(8);
    return `${version}-${traceId}-${novoSpanId}-${flags}`;
  }
  return traceparent;
}

/**
 * Cliente MCP real usando @modelcontextprotocol/client na revisao 2026-07-28,
 * com autoFulfill: false para que o agente receba o input_required cru e construa a ponte A2A.
 */
class McpBridgeClient {
  constructor(mcpUrl) {
    this.mcpUrl = new URL(mcpUrl);
    this.client = null;
    this.discoveredTools = null;
    this.politicaVersao = null;
  }

  async getConnectedClient() {
    if (this.client) return this.client;

    const client = new Client(
      {
        name: "agente-central-de-salas",
        version: "1.0.0",
      },
      {
        capabilities: {
          elicitation: {
            form: {},
          },
        },
        versionNegotiation: {
          mode: { pin: "2026-07-28" },
        },
        inputRequired: {
          autoFulfill: false,
        },
      }
    );

    const transport = new StreamableHTTPClientTransport(this.mcpUrl);
    await client.connect(transport, {
      prior: {
        kind: "modern",
        discover: {
          supportedVersions: ["2026-07-28"],
          capabilities: {
            tools: {},
            resources: {},
          },
        },
      },
    });

    this.client = client;
    return client;
  }

  buildMeta(traceparent) {
    const propagated = propagarTraceparent(traceparent);
    return propagated ? { traceparent: propagated } : undefined;
  }

  /**
   * Descobre as ferramentas via tools/list em runtime antes do primeiro tools/call
   * e le o resource politica://uso para extrair a versao declarada na primeira linha.
   */
  async ensureDiscoveredAndPolicyLoaded(traceparent) {
    const client = await this.getConnectedClient();
    const meta = this.buildMeta(traceparent);

    if (!this.discoveredTools) {
      const listResult = await client.listTools(
        meta ? { _meta: meta } : undefined
      );
      this.discoveredTools = new Map(
        (listResult.tools || []).map((t) => [t.name, t])
      );
    }

    if (!this.politicaVersao) {
      const resResult = await client.readResource({
        uri: "politica://uso",
        ...(meta ? { _meta: meta } : {}),
      });
      const texto = (resResult.contents?.[0]?.text || "").trim();
      const primeiraLinha = texto.split(/\r?\n/)[0] || "";
      const match = primeiraLinha.match(/^versao:\s*(.+)$/i);
      this.politicaVersao = match ? match[1].trim() : "2026-11-01";
    }
  }

  /**
   * Chama reservar_sala via MCP. No retry, envia um novo request (com id JSON-RPC novo)
   * levando inputResponses e o requestState opaco guardado na Task.
   */
  async callReservarSala({
    argumentsObj,
    inputResponses,
    requestState,
    traceparent,
  }) {
    await this.ensureDiscoveredAndPolicyLoaded(traceparent);

    if (!this.discoveredTools || !this.discoveredTools.has("reservar_sala")) {
      throw new Error(
        "Tool reservar_sala nao foi descoberta via tools/list no servidor MCP"
      );
    }

    const client = await this.getConnectedClient();
    const meta = this.buildMeta(traceparent);

    const params = {
      name: "reservar_sala",
      arguments: argumentsObj,
      ...(inputResponses ? { inputResponses } : {}),
      ...(requestState ? { requestState } : {}),
      ...(meta ? { _meta: meta } : {}),
    };

    return client.request(
      {
        method: "tools/call",
        params,
      },
      withInputRequired(specTypeSchemas.CallToolResult),
      {
        allowInputRequired: true,
        headers: {
          "Mcp-Name": "reservar_sala",
        },
      }
    );
  }
}

const mcpBridge = new McpBridgeClient(MCP_URL);

/**
 * Armazenamento em memoria das Tasks A2A e do estado pausado da ponte (separado do payload publico da Task
 * para garantir que requestState nunca vaze em nenhuma resposta A2A).
 */
const tasks = new Map();
const pausedBridges = new Map();

function buildAgentCard() {
  return {
    name: "Central de Salas",
    description: "Reserva salas de reuniao da Hill Valley Tech.",
    provider: {
      organization: "Hill Valley Tech",
      url: "https://hillvalley.example",
    },
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: `http://127.0.0.1:${AGENTE_PORT}${AGENTE_PATH}`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "reservar-sala",
        name: "Reservar sala",
        description:
          "Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.",
        tags: ["salas", "agenda"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        examples: [
          "reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty",
        ],
      },
    ],
  };
}

/**
 * Extrai o texto de uma mensagem A2A.
 */
function extrairTextoMensagem(message) {
  if (!message || !Array.isArray(message.parts)) return "";
  return message.parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join(" ")
    .trim();
}

/**
 * Faz o parse deterministico do pedido fixo:
 * "reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>"
 */
function parsePedidoReserva(texto) {
  const tokens = texto.trim().split(/\s+/);
  if (tokens[0] !== "reservar") return null;

  const campos = {};
  for (let i = 1; i < tokens.length; i++) {
    const idx = tokens[i].indexOf("=");
    if (idx <= 0) continue;
    const chave = tokens[i].slice(0, idx);
    const valor = tokens[i].slice(idx + 1);
    campos[chave] = valor;
  }

  if (!campos.sala || !campos.inicio || !campos.fim || !campos.responsavel) {
    return null;
  }

  return {
    sala: campos.sala,
    inicio: campos.inicio,
    fim: campos.fim,
    responsavel: campos.responsavel,
  };
}

/**
 * Faz o parse deterministico da resposta de continuacao:
 * "escolha=<id da sala>" ou "escolha=recusar"
 */
function parseEscolhaContinuacao(texto) {
  const m = texto.trim().match(/^escolha=(\S+)$/);
  return m ? m[1] : null;
}

function criarMensagemAgente(taskId, contextId, texto) {
  return {
    messageId: `msg-${randomHex(6)}`,
    role: "ROLE_AGENT",
    parts: [{ text: texto }],
    taskId,
    contextId,
  };
}

function atualizarEstadoTask(task, novoEstado, mensagemAgente) {
  if (mensagemAgente) {
    task.status = {
      state: novoEstado,
      message: mensagemAgente,
    };
    task.history.push(mensagemAgente);
  } else {
    task.status = {
      state: novoEstado,
    };
  }
}

/**
 * Extrai a chave de inputRequests e a lista de alternativas (enum ou const) da elicitation form mode.
 */
function extrairDadosElicitation(mcpResult) {
  const inputRequests = mcpResult.inputRequests || {};
  const chave = Object.keys(inputRequests)[0];
  if (!chave) {
    return { chave: "escolha_de_sala", alternativas: [] };
  }
  const req = inputRequests[chave] || {};
  const propSala = req?.params?.requestedSchema?.properties?.sala || {};
  let alternativas = [];
  if (Array.isArray(propSala.enum)) {
    alternativas = propSala.enum;
  } else if (typeof propSala.const === "string") {
    alternativas = [propSala.const];
  }
  return { chave, alternativas };
}

/**
 * Processa o resultado de reservar_sala vindo do servidor MCP e atualiza a Task A2A.
 * Esta funcao implementa a ponte MCP (MRTR) -> A2A (Task).
 */
function aplicarResultadoMcpNaTask(task, mcpResult, argumentsOriginais) {
  // 1. Caso MRTR: servidor MCP respondeu input_required com elicitation e requestState
  if (isInputRequiredResult(mcpResult)) {
    const { chave, alternativas } = extrairDadosElicitation(mcpResult);

    // Guarda o requestState opaco associado a esta Task sem nunca expor na Task A2A
    pausedBridges.set(task.id, {
      requestState: mcpResult.requestState,
      inputKey: chave,
      alternativas,
      originalArguments: argumentsOriginais,
    });

    const textoAlternativas = `alternativas: ${alternativas.join(", ")}`;
    const msgAgente = criarMensagemAgente(
      task.id,
      task.contextId,
      textoAlternativas
    );
    atualizarEstadoTask(task, "TASK_STATE_INPUT_REQUIRED", msgAgente);
    return;
  }

  // Limpa qualquer estado pausado anterior desta Task
  pausedBridges.delete(task.id);

  // 2. Caso Erro de execucao da tool (isError: true) -> TASK_STATE_FAILED
  if (mcpResult.isError) {
    const textoErro = (mcpResult.content || [])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join(" ")
      .trim();
    const msgErro = criarMensagemAgente(task.id, task.contextId, textoErro);
    atualizarEstadoTask(task, "TASK_STATE_FAILED", msgErro);
    return;
  }

  // 3. Caso Complete: verifica se foi reservado ou recusado
  const dados = mcpResult.structuredContent || {};

  if (dados.reservado === false) {
    const msgCancel = criarMensagemAgente(
      task.id,
      task.contextId,
      "Reserva cancelada a pedido do usuario."
    );
    atualizarEstadoTask(task, "TASK_STATE_CANCELED", msgCancel);
    return;
  }

  // Reserva concluida com sucesso -> produz artifact "reserva" com a versao da politica lida do resource
  const payloadArtifact = {
    reserva: dados.reserva,
    sala: dados.sala,
    inicio: dados.inicio,
    fim: dados.fim,
    responsavel: dados.responsavel,
    politica: mcpBridge.politicaVersao || dados.politica || "2026-11-01",
  };

  task.artifacts = [
    {
      artifactId: `art-${randomHex(6)}`,
      name: "reserva",
      parts: [
        {
          text: JSON.stringify(payloadArtifact),
        },
      ],
    },
  ];

  const msgSucesso = criarMensagemAgente(
    task.id,
    task.contextId,
    `Reserva ${payloadArtifact.reserva} confirmada na ${payloadArtifact.sala}.`
  );
  atualizarEstadoTask(task, "TASK_STATE_COMPLETED", msgSucesso);
}

/**
 * Manipula SendMessage do protocolo A2A v1.0.
 */
async function handleSendMessage(params, traceparent, rpcId) {
  const incomingMessage = params?.message;
  if (!incomingMessage || typeof incomingMessage !== "object") {
    return {
      jsonrpc: "2.0",
      id: rpcId,
      error: {
        code: -32602,
        message: "Invalid params: message is required",
      },
    };
  }

  const texto = extrairTextoMensagem(incomingMessage);
  const taskIdInformado = incomingMessage.taskId;

  // Caso A: Continuacao de uma Task existente
  if (taskIdInformado) {
    const task = tasks.get(taskIdInformado);
    if (!task) {
      return {
        jsonrpc: "2.0",
        id: rpcId,
        error: {
          code: -32001,
          message: `Task not found: ${taskIdInformado}`,
        },
      };
    }

    // Estado terminal e definitivo: recusar SendMessage referenciando Task terminal
    if (TERMINAL_STATES.has(task.status?.state)) {
      return {
        jsonrpc: "2.0",
        id: rpcId,
        error: {
          code: -32600,
          message: `Task ${task.id} is in terminal state ${task.status.state} and cannot be resumed`,
        },
      };
    }

    const bridgeState = pausedBridges.get(task.id);
    if (!bridgeState || task.status?.state !== "TASK_STATE_INPUT_REQUIRED") {
      return {
        jsonrpc: "2.0",
        id: rpcId,
        error: {
          code: -32600,
          message: `Task ${task.id} is not waiting for input`,
        },
      };
    }

    const userMsgEntry = {
      messageId: incomingMessage.messageId || `msg-${randomHex(6)}`,
      role: incomingMessage.role || "ROLE_USER",
      parts: incomingMessage.parts || [{ text: texto }],
      taskId: task.id,
    };
    task.history.push(userMsgEntry);

    const escolha = parseEscolhaContinuacao(texto);

    // Se a escolha for "recusar", envia action: "decline" ao servidor MCP e termina em TASK_STATE_CANCELED
    if (escolha === "recusar") {
      atualizarEstadoTask(task, "TASK_STATE_WORKING");
      const mcpResult = await mcpBridge.callReservarSala({
        argumentsObj: bridgeState.originalArguments,
        inputResponses: {
          [bridgeState.inputKey]: {
            action: "decline",
          },
        },
        requestState: bridgeState.requestState,
        traceparent,
      });
      aplicarResultadoMcpNaTask(
        task,
        mcpResult,
        bridgeState.originalArguments
      );
      return {
        jsonrpc: "2.0",
        id: rpcId,
        result: { task },
      };
    }

    // Escolha fora do enum mantem a Task em TASK_STATE_INPUT_REQUIRED e repete a lista de alternativas
    if (!escolha || !bridgeState.alternativas.includes(escolha)) {
      const textoAlternativas = `alternativas: ${bridgeState.alternativas.join(", ")}`;
      const msgAgente = criarMensagemAgente(
        task.id,
        task.contextId,
        textoAlternativas
      );
      atualizarEstadoTask(task, "TASK_STATE_INPUT_REQUIRED", msgAgente);
      return {
        jsonrpc: "2.0",
        id: rpcId,
        result: { task },
      };
    }

    // Escolha valida dentro do enum: transita por WORKING e envia retry ao servidor MCP com id novo
    atualizarEstadoTask(task, "TASK_STATE_WORKING");
    const mcpResult = await mcpBridge.callReservarSala({
      argumentsObj: bridgeState.originalArguments,
      inputResponses: {
        [bridgeState.inputKey]: {
          action: "accept",
          content: { sala: escolha },
        },
      },
      requestState: bridgeState.requestState,
      traceparent,
    });

    aplicarResultadoMcpNaTask(task, mcpResult, bridgeState.originalArguments);
    return {
      jsonrpc: "2.0",
      id: rpcId,
      result: { task },
    };
  }

  // Caso B: Nova Task (SendMessage sem taskId)
  const taskId = `task-${randomHex(6)}`;
  const contextId = incomingMessage.contextId || `ctx-${randomHex(6)}`;

  const userMsgEntry = {
    messageId: incomingMessage.messageId || `msg-${randomHex(6)}`,
    role: incomingMessage.role || "ROLE_USER",
    parts: incomingMessage.parts || [{ text: texto }],
  };

  const task = {
    id: taskId,
    contextId,
    status: {
      state: "TASK_STATE_SUBMITTED",
    },
    history: [userMsgEntry],
    artifacts: [],
  };
  tasks.set(taskId, task);

  // Transita para TASK_STATE_WORKING
  atualizarEstadoTask(task, "TASK_STATE_WORKING");

  const pedido = parsePedidoReserva(texto);
  if (!pedido) {
    const msgErro = criarMensagemAgente(
      task.id,
      task.contextId,
      "Formato de pedido invalido. Use: reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>"
    );
    atualizarEstadoTask(task, "TASK_STATE_FAILED", msgErro);
    return {
      jsonrpc: "2.0",
      id: rpcId,
      result: { task },
    };
  }

  try {
    const mcpResult = await mcpBridge.callReservarSala({
      argumentsObj: pedido,
      traceparent,
    });
    aplicarResultadoMcpNaTask(task, mcpResult, pedido);
  } catch (err) {
    const errMsg =
      err instanceof ProtocolError || err instanceof Error
        ? err.message
        : String(err);
    const msgErro = criarMensagemAgente(task.id, task.contextId, errMsg);
    atualizarEstadoTask(task, "TASK_STATE_FAILED", msgErro);
  }

  return {
    jsonrpc: "2.0",
    id: rpcId,
    result: { task },
  };
}

/**
 * Manipula GetTask do protocolo A2A v1.0.
 */
async function handleGetTask(params, rpcId) {
  const taskId = params?.id;
  if (!taskId || typeof taskId !== "string") {
    return {
      jsonrpc: "2.0",
      id: rpcId,
      error: {
        code: -32602,
        message: "Invalid params: id is required",
      },
    };
  }

  const task = tasks.get(taskId);
  if (!task) {
    return {
      jsonrpc: "2.0",
      id: rpcId,
      error: {
        code: -32001,
        message: `Task not found: ${taskId}`,
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id: rpcId,
    result: { task },
  };
}

function lerCorpoJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  // 1. Well-known Agent Card (A2A v1.0)
  if (
    req.method === "GET" &&
    url.pathname === "/.well-known/agent-card.json"
  ) {
    const card = buildAgentCard();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(card, null, 2));
    return;
  }

  // 2. Endpoint JSON-RPC A2A (/a2a)
  if (req.method === "POST" && url.pathname === AGENTE_PATH) {
    let body;
    try {
      body = await lerCorpoJson(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })
      );
      return;
    }

    const rpcId = body?.id ?? null;
    const method = body?.method;
    const params = body?.params || {};
    const traceparent = req.headers["traceparent"];

    if (body?.jsonrpc !== "2.0" || typeof method !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32600, message: "Invalid JSON-RPC request" },
        })
      );
      return;
    }

    let responsePayload;
    if (method === "SendMessage") {
      responsePayload = await handleSendMessage(params, traceparent, rpcId);
    } else if (method === "GetTask") {
      responsePayload = await handleGetTask(params, rpcId);
    } else {
      responsePayload = {
        jsonrpc: "2.0",
        id: rpcId,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responsePayload));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(AGENTE_PORT, "0.0.0.0", () => {
  console.error(
    `[AGENTE] Agente A2A Central de Salas ouvindo em http://localhost:${AGENTE_PORT}${AGENTE_PATH}`
  );
});
