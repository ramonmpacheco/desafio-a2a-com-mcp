# A Ponte: um agente A2A com MCP por dentro

Implementação do desafio **A Ponte**, conectando um servidor **MCP v2** (revisão `2026-07-28`, Streamable HTTP stateless com ciclo completo de MRTR) na porta `7301` e um agente determinístico que atua como **host/cliente MCP por dentro** e **servidor A2A v1.0 por fora** (JSON-RPC 2.0 sobre HTTP) na porta `7300`.

---

## Como rodar

### Pré-requisitos
- **Node.js 20+** (ESM) e `npm`
- **Python 3.10+** (apenas biblioteca padrão, para executar o `validador/validar.py`)

### 1. Instalar dependências
A partir de um clone limpo, na raiz do repositório:

```bash
npm install
```

### 2. Gerar e exportar o segredo do `requestState`
O servidor MCP exige a variável de ambiente `REQUEST_STATE_SECRET` com no mínimo 32 bytes de aleatoriedade (nunca hardcoded no código). Gere e exporte o segredo no terminal em que for subir o servidor MCP:

```bash
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
```

### 3. Subir o Servidor MCP (Terminal 1)
Inicie o servidor MCP na porta `7301` (endpoint `/mcp`), mantendo o `stderr` visível para acompanhar os logs de `method`, `id` e `traceparent`:

```bash
node servidor-mcp/index.mjs
```

### 4. Subir o Agente A2A (Terminal 2)
Em outro terminal, inicie o agente na porta `7300` (endpoint JSON-RPC em `/a2a` e Agent Card em `/.well-known/agent-card.json`):

```bash
node agente/index.mjs
```

### 5. Executar o Validador (Terminal 3)
Com os dois processos recém-iniciados, execute o validador oficial:

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

---

## Onde a ponte acontece

A ponte entre o protocolo MCP (MRTR stateless) e o protocolo A2A (ciclo de vida de `Task`) acontece em [`agente/index.mjs`](agente/index.mjs), especificamente entre as funções `aplicarResultadoMcpNaTask`, `handleSendMessage` e `McpBridgeClient.callReservarSala`: quando o agente chama `tools/call` (`reservar_sala`) passando `{ allowInputRequired: true }` (com `autoFulfill: false` configurado no `Client` do `@modelcontextprotocol/client`) e o servidor MCP detecta conflito de horário, o servidor encerra a resposta HTTP devolvendo `resultType: "input_required"`, um mapa `inputRequests` com a elicitation em modo `form` e o `requestState` assinado. Em `aplicarResultadoMcpNaTask` ([`agente/index.mjs`](agente/index.mjs#L276-L296)), o agente intercepta esse resultado via `isInputRequiredResult(mcpResult)`, extrai as salas do `enum`/`const` do `requestedSchema`, guarda o `requestState` opaco no mapa privado `pausedBridges` indexado pelo `task.id` (fora da estrutura pública da `Task`, impedindo qualquer vazamento nas respostas A2A) e transita a `Task` para `TASK_STATE_INPUT_REQUIRED` com a mensagem exata `alternativas: <ids>`. Em seguida, quando o cliente A2A envia um novo `SendMessage` referenciando o mesmo `taskId` com `escolha=<id>` (ou `escolha=recusar`), `handleSendMessage` ([`agente/index.mjs`](agente/index.mjs#L395-L456)) recupera o `requestState` e a chave do `inputRequests` guardados em `pausedBridges` para aquela `Task` e invoca `mcpBridge.callReservarSala` ([`agente/index.mjs`](agente/index.mjs#L118-L155)), que emite uma nova requisição `tools/call` com um novo `id` JSON-RPC carregando `inputResponses` (`action: "accept"` ou `"decline"`) e o `requestState` ecoado byte a byte para o servidor MCP concluir ou cancelar a operação.

---

## Decisões técnicas

- **Proteção e integridade do `requestState`:** Utilizamos o utilitário oficial `createRequestStateCodec` do `@modelcontextprotocol/server` (`v2.4.0`) em [`servidor-mcp/index.mjs`](servidor-mcp/index.mjs#L30-L33), que aplica assinatura **HMAC-SHA256** (via Web Crypto API e verificação em tempo constante) sobre o envelope contendo os parâmetros originais selados (`salaOriginal`, `inicio`, `fim`, `responsavel`, `alternativas` e `chave`) e o timestamp de expiração (`exp`). A chave criptográfica é lida exclusivamente da variável de ambiente `REQUEST_STATE_SECRET` (validada na subida com no mínimo 32 bytes). A verificação é registrada no hook `ServerOptions.requestState.verify`, de modo que qualquer adulteração de bytes ou expiração do token faz o SDK rejeitar imediatamente a chamada com erro JSON-RPC `-32602` antes mesmo de entrar no handler da tool. Além disso, no retry, o servidor reconstrói o pedido exclusivamente a partir do payload selado no `requestState`, ignorando argumentos adulterados pelo cliente e garantindo funcionamento mesmo após reinício do processo do servidor MCP.
- **Tempo de validade (TTL) do `requestState`:** Configurado em **600 segundos (10 minutos)** (`ttlSeconds: 600`), dentro da janela de 5 a 30 minutos especificada pelos requisitos.
- **Armazenamento do estado das Tasks A2A:** Guardado em memória no processo do agente ([`agente/index.mjs`](agente/index.mjs#L164-L165)) em dois `Map` separados e indexados por `taskId`:
  1. `tasks`: armazena a representação pública da `Task` A2A (`id`, `contextId`, `status`, `history` e `artifacts`), consultável por `GetTask` e retornada em `SendMessage`.
  2. `pausedBridges`: armazena exclusivamente o estado interno da ponte (`requestState` opaco, `inputKey`, `alternativas` permitidas e `originalArguments`) enquanto a `Task` está em `TASK_STATE_INPUT_REQUIRED`. Essa separação física garante isolamento total entre múltiplas Tasks pausadas simultaneamente e impossibilita que o `requestState` apareça no Agent Card, nos artifacts ou nas mensagens A2A.

---

## Saída do validador

```text
trace-id desta execucao: e583c21408b025d7b017159fc483f6b4
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
