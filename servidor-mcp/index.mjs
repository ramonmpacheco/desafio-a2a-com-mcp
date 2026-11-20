import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  acceptedContent,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DADOS_DIR = path.join(ROOT_DIR, "dados");

const PORT = Number(process.env.MCP_PORT || process.env.PORT || 7301);
const MCP_PATH = process.env.MCP_PATH || "/mcp";
const SECRET = process.env.REQUEST_STATE_SECRET;

if (!SECRET || Buffer.byteLength(SECRET, "utf-8") < 32) {
  console.error(
    "Erro fatal: a variavel de ambiente REQUEST_STATE_SECRET e obrigatoria e deve ter no minimo 32 bytes."
  );
  process.exit(1);
}

// Codec HMAC-SHA256 com TTL de 600s (10 minutos, entre 5 e 30 minutos exigidos)
const stateCodec = createRequestStateCodec({
  key: SECRET,
  ttlSeconds: 600,
});

// Carrega dados iniciais em memoria
const salas = JSON.parse(
  fs.readFileSync(path.join(DADOS_DIR, "salas.json"), "utf-8")
);
const reservas = JSON.parse(
  fs.readFileSync(path.join(DADOS_DIR, "reservas.json"), "utf-8")
);
const politicaTexto = fs.readFileSync(
  path.join(DADOS_DIR, "politica-de-uso.md"),
  "utf-8"
);

function extrairVersaoPolitica(texto) {
  const primeiraLinha = texto.split(/\r?\n/)[0] || "";
  const match = primeiraLinha.match(/^versao:\s*(.+)$/i);
  return match ? match[1].trim() : "2026-11-01";
}

const VERSAO_POLITICA = extrairVersaoPolitica(politicaTexto);

// Contador sequencial de reservas a partir das existentes em dados/reservas.json
let proximoIdNumero =
  reservas.reduce((max, r) => {
    const m = String(r.id).match(/^res-(\d+)$/);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0) + 1;

function gerarIdReserva() {
  const num = proximoIdNumero++;
  return `res-${String(num).padStart(4, "0")}`;
}

/**
 * Converte string ISO-8601 para Date e calcula minutos desde 00:00 no fuso de Sao Paulo (-03:00).
 */
function parseIsoSaoPaulo(isoStr) {
  if (typeof isoStr !== "string") return null;
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return null;

  // Converte para o horario de Sao Paulo (UTC-3 = -180 minutos)
  const spMs = dt.getTime() - 3 * 60 * 60 * 1000;
  const spDate = new Date(spMs);
  const diaSp = `${spDate.getUTCFullYear()}-${String(
    spDate.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(spDate.getUTCDate()).padStart(2, "0")}`;
  const minutosDoDia =
    spDate.getUTCHours() * 60 +
    spDate.getUTCMinutes() +
    spDate.getUTCSeconds() / 60;

  return {
    epochMs: dt.getTime(),
    diaSp,
    minutosDoDia,
  };
}

/**
 * Valida a sala e as regras da politica de uso.
 * Retorna string com a mensagem exata de erro ou null se estiver tudo valido.
 */
function validarSalaEIntervalo(salaId, inicioStr, fimStr) {
  const salaObj = salas.find((s) => s.id === salaId);
  if (!salaObj) {
    return `Sala inexistente: ${salaId}`;
  }

  const inicio = parseIsoSaoPaulo(inicioStr);
  const fim = parseIsoSaoPaulo(fimStr);

  if (!inicio || !fim || fim.epochMs <= inicio.epochMs) {
    return "Intervalo invalido: fim deve ser posterior a inicio";
  }

  const duracaoMs = fim.epochMs - inicio.epochMs;
  const duasHorasMs = 2 * 60 * 60 * 1000;

  // Verifica janela de uso: entre 08:00 (480 min) e 20:00 (1200 min) no mesmo dia de Sao Paulo
  const dentroJanelaInicio =
    inicio.minutosDoDia >= 8 * 60 && inicio.minutosDoDia <= 20 * 60;
  const dentroJanelaFim =
    fim.minutosDoDia >= 8 * 60 && fim.minutosDoDia <= 20 * 60;
  const mesmoDia = inicio.diaSp === fim.diaSp;

  if (!mesmoDia || !dentroJanelaInicio || !dentroJanelaFim) {
    return "Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00";
  }

  if (duracaoMs > duasHorasMs) {
    return "Duracao acima do limite: a politica permite no maximo 2 horas";
  }

  return null;
}

/**
 * Retorna as reservas existentes que se sobrepoem ao intervalo [inicioStr, fimStr) para a sala.
 */
function buscarConflitos(salaId, inicioStr, fimStr) {
  const ini = new Date(inicioStr).getTime();
  const fim = new Date(fimStr).getTime();
  return reservas.filter((r) => {
    if (r.sala !== salaId) return false;
    const rIni = new Date(r.inicio).getTime();
    const rFim = new Date(r.fim).getTime();
    return rIni < fim && rFim > ini;
  });
}

/**
 * Calcula ate 3 salas alternativas livres no intervalo, com capacidade >= a da sala pedida,
 * ordenadas por capacidade crescente e, em empate, por id em ordem alfabetica.
 */
function calcularAlternativas(salaPedidaId, inicioStr, fimStr) {
  const salaPedida = salas.find((s) => s.id === salaPedidaId);
  if (!salaPedida) return [];

  return salas
    .filter((s) => {
      if (s.id === salaPedidaId) return false;
      if (s.capacidade < salaPedida.capacidade) return false;
      const conflitos = buscarConflitos(s.id, inicioStr, fimStr);
      return conflitos.length === 0;
    })
    .sort((a, b) => {
      if (a.capacidade !== b.capacidade) {
        return a.capacidade - b.capacidade;
      }
      return a.id.localeCompare(b.id);
    })
    .slice(0, 3)
    .map((s) => s.id);
}

// Schemas JSON das 3 tools
const listarSalasInputSchema = fromJsonSchema({
  type: "object",
  properties: {},
  title: "listar_salasArguments",
});

const listarSalasOutputSchema = fromJsonSchema({
  $defs: {
    SalaOut: {
      properties: {
        id: { title: "Id", type: "string" },
        nome: { title: "Nome", type: "string" },
        capacidade: { title: "Capacidade", type: "integer" },
        recursos: {
          items: { type: "string" },
          title: "Recursos",
          type: "array",
        },
      },
      required: ["id", "nome", "capacidade", "recursos"],
      title: "SalaOut",
      type: "object",
    },
  },
  properties: {
    salas: {
      items: { $ref: "#/$defs/SalaOut" },
      title: "Salas",
      type: "array",
    },
  },
  required: ["salas"],
  title: "ListaDeSalas",
  type: "object",
});

const consultarDisponibilidadeInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    sala: { title: "Sala", type: "string" },
    inicio: { title: "Inicio", type: "string" },
    fim: { title: "Fim", type: "string" },
  },
  required: ["sala", "inicio", "fim"],
  title: "consultar_disponibilidadeArguments",
});

const consultarDisponibilidadeOutputSchema = fromJsonSchema({
  $defs: {
    ConflitoOut: {
      properties: {
        id: { title: "Id", type: "string" },
        inicio: { title: "Inicio", type: "string" },
        fim: { title: "Fim", type: "string" },
        responsavel: { title: "Responsavel", type: "string" },
      },
      required: ["id", "inicio", "fim", "responsavel"],
      title: "ConflitoOut",
      type: "object",
    },
  },
  properties: {
    sala: { title: "Sala", type: "string" },
    livre: { title: "Livre", type: "boolean" },
    conflitos: {
      items: { $ref: "#/$defs/ConflitoOut" },
      title: "Conflitos",
      type: "array",
    },
  },
  required: ["sala", "livre", "conflitos"],
  title: "Disponibilidade",
  type: "object",
});

const reservarSalaInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    sala: { title: "Sala", type: "string" },
    inicio: { title: "Inicio", type: "string" },
    fim: { title: "Fim", type: "string" },
    responsavel: { title: "Responsavel", type: "string" },
  },
  required: ["sala", "inicio", "fim", "responsavel"],
  title: "reservar_salaArguments",
});

const reservarSalaOutputSchema = fromJsonSchema({
  properties: {
    reserva: {
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
      title: "Reserva",
    },
    reservado: {
      default: true,
      title: "Reservado",
      type: "boolean",
    },
    sala: {
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
      title: "Sala",
    },
    inicio: {
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
      title: "Inicio",
    },
    fim: {
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
      title: "Fim",
    },
    responsavel: {
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
      title: "Responsavel",
    },
    politica: {
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
      title: "Politica",
    },
    motivo: {
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
      title: "Motivo",
    },
  },
  title: "ReservaOut",
  type: "object",
});

const ELICITATION_KEY = "escolha_de_sala";

function buildMcpServer() {
  const server = new McpServer(
    {
      name: "central-de-salas",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      requestState: {
        verify: (state, ctx) => stateCodec.verify(state, ctx),
      },
    }
  );

  // Resource: politica://uso
  server.registerResource(
    "politica-de-uso",
    "politica://uso",
    {
      title: "Politica de Uso das Salas",
      description: "Regras e politica de uso para reserva de salas.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: politicaTexto,
        },
      ],
    })
  );

  // Tool 1: listar_salas
  server.registerTool(
    "listar_salas",
    {
      description: "Lista todas as salas com capacidade e recursos.",
      inputSchema: listarSalasInputSchema,
      outputSchema: listarSalasOutputSchema,
    },
    async () => {
      const payload = { salas };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );

  // Tool 2: consultar_disponibilidade
  server.registerTool(
    "consultar_disponibilidade",
    {
      description:
        "Diz se uma sala esta livre no intervalo, e quais reservas conflitam.",
      inputSchema: consultarDisponibilidadeInputSchema,
      outputSchema: consultarDisponibilidadeOutputSchema,
    },
    async (args) => {
      const { sala, inicio, fim } = args;
      const erroValidacao = validarSalaEIntervalo(sala, inicio, fim);
      if (erroValidacao) {
        return {
          content: [{ type: "text", text: erroValidacao }],
          isError: true,
        };
      }

      const conflitos = buscarConflitos(sala, inicio, fim).map((c) => ({
        id: c.id,
        inicio: c.inicio,
        fim: c.fim,
        responsavel: c.responsavel,
      }));

      const payload = {
        sala,
        livre: conflitos.length === 0,
        conflitos,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );

  // Tool 3: reservar_sala (com ciclo completo de MRTR)
  server.registerTool(
    "reservar_sala",
    {
      description:
        "Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.",
      inputSchema: reservarSalaInputSchema,
      outputSchema: reservarSalaOutputSchema,
    },
    async (args, ctx) => {
      // Verifica se estamos em um retry com requestState ja verificado pelo hook requestState.verify
      const estadoSelado = ctx.mcpReq.requestState();

      if (estadoSelado !== undefined) {
        // Reconstroi o pedido original a partir do requestState selado (ignora adulteracao em args)
        const {
          inicio,
          fim,
          responsavel,
          alternativas,
          chave = ELICITATION_KEY,
        } = estadoSelado;

        const respView = inputResponse(ctx.mcpReq.inputResponses, chave);

        if (
          respView.kind === "elicit" &&
          (respView.action === "decline" || respView.action === "cancel")
        ) {
          const payload = {
            reserva: null,
            reservado: false,
            sala: null,
            inicio: null,
            fim: null,
            responsavel: null,
            politica: null,
            motivo: "recusado",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            structuredContent: payload,
            isError: false,
          };
        }

        const content = acceptedContent(ctx.mcpReq.inputResponses, chave);
        const salaEscolhida =
          content && typeof content.sala === "string" ? content.sala : null;

        if (
          !salaEscolhida ||
          !Array.isArray(alternativas) ||
          !alternativas.includes(salaEscolhida)
        ) {
          // Se não veio escolha valida, pede novamente a elicitation mantendo o estado selado
          const novoState = await stateCodec.mint(estadoSelado, ctx);
          return inputRequired({
            inputRequests: {
              [chave]: inputRequired.elicit({
                mode: "form",
                message:
                  "A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.",
                requestedSchema: {
                  type: "object",
                  properties: {
                    sala: {
                      type: "string",
                      title: "Sala",
                      description: "Sala alternativa escolhida",
                      enum: alternativas,
                    },
                  },
                  required: ["sala"],
                },
              }),
            },
            requestState: novoState,
          });
        }

        // Conclui a reserva na sala escolhida usando os dados selados no requestState
        const idReserva = gerarIdReserva();
        const novaReserva = {
          id: idReserva,
          sala: salaEscolhida,
          inicio,
          fim,
          responsavel,
        };
        reservas.push(novaReserva);

        const payload = {
          reserva: idReserva,
          reservado: true,
          sala: salaEscolhida,
          inicio,
          fim,
          responsavel,
          politica: VERSAO_POLITICA,
          motivo: null,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
          isError: false,
        };
      }

      // Primeira chamada (sem requestState)
      const { sala, inicio, fim, responsavel } = args;
      const erroValidacao = validarSalaEIntervalo(sala, inicio, fim);
      if (erroValidacao) {
        return {
          content: [{ type: "text", text: erroValidacao }],
          isError: true,
        };
      }

      const conflitos = buscarConflitos(sala, inicio, fim);
      if (conflitos.length === 0) {
        const idReserva = gerarIdReserva();
        const novaReserva = {
          id: idReserva,
          sala,
          inicio,
          fim,
          responsavel,
        };
        reservas.push(novaReserva);

        const payload = {
          reserva: idReserva,
          reservado: true,
          sala,
          inicio,
          fim,
          responsavel,
          politica: VERSAO_POLITICA,
          motivo: null,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
          isError: false,
        };
      }

      // Ha conflito: calcula alternativas
      const alternativas = calcularAlternativas(sala, inicio, fim);
      if (alternativas.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Sem alternativas disponiveis no intervalo",
            },
          ],
          isError: true,
        };
      }

      // Minta o requestState selado com HMAC-SHA256
      const sealedPayload = {
        salaOriginal: sala,
        inicio,
        fim,
        responsavel,
        alternativas,
        chave: ELICITATION_KEY,
      };
      const mintedState = await stateCodec.mint(sealedPayload, ctx);

      return inputRequired({
        inputRequests: {
          [ELICITATION_KEY]: inputRequired.elicit({
            mode: "form",
            message:
              "A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.",
            requestedSchema: {
              type: "object",
              properties: {
                sala: {
                  type: "string",
                  title: "Sala",
                  description: "Sala alternativa escolhida",
                  enum: alternativas,
                },
              },
              required: ["sala"],
            },
          }),
        },
        requestState: mintedState,
      });
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(() => buildMcpServer());

// Wrapper para registrar no stderr o método, o id e o traceparent de cada request recebido
// e garantir que requests sem _meta obrigatorio recebam -32602 com HTTP 400.
const wrappedFetch = async (request) => {
  if (request.method.toUpperCase() === "POST") {
    let body = null;
    try {
      const cloned = request.clone();
      const text = await cloned.text();
      if (text) body = JSON.parse(text);
    } catch {
      // deixa o handler do SDK responder parse error
    }

    if (body && typeof body === "object" && !Array.isArray(body)) {
      const method = body.method ?? "unknown";
      const id = body.id ?? null;
      const meta =
        body.params && typeof body.params === "object"
          ? body.params._meta
          : undefined;
      const traceparent =
        (meta && typeof meta === "object" ? meta.traceparent : undefined) ||
        request.headers.get("traceparent") ||
        "-";

      console.error(
        `[MCP] method=${method} id=${id} traceparent=${traceparent}`
      );

      // Requisito explicito: Rejeitar com -32602 e HTTP 400 qualquer request sem os campos obrigatorios de _meta
      const hasProtocolVersion =
        meta &&
        typeof meta === "object" &&
        typeof meta["io.modelcontextprotocol/protocolVersion"] === "string";
      const hasClientCapabilities =
        meta &&
        typeof meta === "object" &&
        meta["io.modelcontextprotocol/clientCapabilities"] !== null &&
        typeof meta["io.modelcontextprotocol/clientCapabilities"] === "object";

      if (!hasProtocolVersion || !hasClientCapabilities) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message:
                "Invalid params: missing required _meta fields (io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities)",
            },
          },
          { status: 400 }
        );
      }
    }
  }

  return mcpHandler.fetch(request);
};

const nodeHandler = toNodeHandler({ fetch: wrappedFetch });

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
    return;
  }
  await nodeHandler(req, res);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.error(
    `[MCP] Servidor MCP central-de-salas ouvindo em http://localhost:${PORT}${MCP_PATH}`
  );
});
