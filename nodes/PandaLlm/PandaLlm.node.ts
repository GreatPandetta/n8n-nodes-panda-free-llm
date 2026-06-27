import {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	NodeConnectionTypes,
	SupplyData,
} from 'n8n-workflow';

import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
	AIMessage,
	AIMessageChunk,
	BaseMessage,
	ToolMessage,
} from '@langchain/core/messages';
import { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { BindToolsInput } from '@langchain/core/language_models/chat_models';
import { Runnable } from '@langchain/core/runnables';
import { BaseLanguageModelCallOptions, BaseLanguageModelInput } from '@langchain/core/language_models/base';

const PROVIDER_BASE_URLS: Record<string, string> = {
	groq: 'https://api.groq.com/openai/v1',
	cerebras: 'https://api.cerebras.ai/v1',
	gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
	openrouter: 'https://openrouter.ai/api/v1',
	mistral: 'https://api.mistral.ai/v1',
};

const PROVIDER_CRED_FIELD: Record<string, string> = {
	groq: 'groqApiKey',
	cerebras: 'cerebrasApiKey',
	gemini: 'geminiApiKey',
	openrouter: 'openRouterApiKey',
	mistral: 'mistralApiKey',
};

const PROVIDER_LABELS: Record<string, string> = {
	groq: 'Groq',
	cerebras: 'Cerebras',
	gemini: 'Gemini',
	openrouter: 'OpenRouter',
	mistral: 'Mistral',
};

const DEFAULT_MODELS: Record<string, string> = {
	groq: 'llama-3.3-70b-versatile',
	cerebras: 'llama-3.3-70b',
	gemini: 'gemini-2.5-flash',
	openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
	mistral: 'mistral-small-latest',
};

const PROVIDER_OPTIONS = Object.keys(PROVIDER_BASE_URLS).map((service) => ({
	name: PROVIDER_LABELS[service],
	value: service,
}));

const VALUE_SEP = '::';

interface ProviderStep {
	baseUrl: string;
	apiKey: string;
	model: string;
	name: string;
}

interface PandaChatFields extends BaseChatModelParams {
	chain: ProviderStep[];
	temperature: number;
	maxTokens: number;
	timeout: number;
	responseFormat: string;
}

// ── A LangChain chat model that fails over across free providers ──────────────
// Depends only on @langchain/core (peer dep -> uses n8n's copy) and makes
// direct OpenAI-compatible /chat/completions calls. Supports tool calling so
// it works inside n8n's AI Agent.
class PandaFailoverChat extends BaseChatModel<BaseLanguageModelCallOptions> {
	private chain: ProviderStep[];
	private temperature: number;
	private maxTokens: number;
	private timeoutMs: number;
	private responseFormat: string;
	private boundTools?: IDataObject[];

	constructor(fields: PandaChatFields) {
		super(fields);
		this.chain = fields.chain;
		this.temperature = fields.temperature;
		this.maxTokens = fields.maxTokens;
		this.timeoutMs = fields.timeout;
		this.responseFormat = fields.responseFormat;
	}

	_llmType(): string {
		return 'panda-free-llm';
	}

	override bindTools(
		tools: BindToolsInput[],
		kwargs?: Partial<BaseLanguageModelCallOptions>,
	): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseLanguageModelCallOptions> {
		const openAiTools = tools.map((t) => convertToOpenAITool(t)) as unknown as IDataObject[];
		const clone = new PandaFailoverChat({
			chain: this.chain,
			temperature: this.temperature,
			maxTokens: this.maxTokens,
			timeout: this.timeoutMs,
			responseFormat: this.responseFormat,
		});
		clone.boundTools = openAiTools;
		return clone.withConfig(kwargs ?? {}) as unknown as Runnable<
			BaseLanguageModelInput,
			AIMessageChunk,
			BaseLanguageModelCallOptions
		>;
	}

	private toOpenAiMessages(messages: BaseMessage[]): IDataObject[] {
		return messages.map((m) => {
			const type = m._getType();
			const content =
				typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

			if (type === 'system') return { role: 'system', content };
			if (type === 'human') return { role: 'user', content };
			if (type === 'tool') {
				const tm = m as ToolMessage;
				return { role: 'tool', content, tool_call_id: tm.tool_call_id };
			}
			if (type === 'ai') {
				const am = m as AIMessage;
				const msg: IDataObject = { role: 'assistant', content: content || null };
				if (am.tool_calls && am.tool_calls.length > 0) {
					msg.tool_calls = am.tool_calls.map((tc) => ({
						id: tc.id,
						type: 'function',
						function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
					}));
				}
				return msg;
			}
			return { role: 'user', content };
		});
	}

	async _generate(
		messages: BaseMessage[],
		_options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const oaMessages = this.toOpenAiMessages(messages);
		const wantJson = this.responseFormat === 'json';

		// OpenAI-compatible JSON mode expects "json" to appear in the prompt.
		if (wantJson) {
			const mentionsJson = oaMessages.some((m) =>
				typeof m.content === 'string' ? /json/i.test(m.content) : false,
			);
			if (!mentionsJson) {
				oaMessages.unshift({
					role: 'system',
					content: 'Respond with a single valid JSON object only. No markdown, no code fences.',
				});
			}
		}

		let lastError: Error | undefined;

		for (const step of this.chain) {
			const body: IDataObject = {
				model: step.model,
				messages: oaMessages,
				temperature: this.temperature,
				max_tokens: this.maxTokens,
			};
			if (this.boundTools && this.boundTools.length > 0) {
				body.tools = this.boundTools;
			}
			if (wantJson) {
				body.response_format = { type: 'json_object' };
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				const res = await fetch(`${step.baseUrl}/chat/completions`, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${step.apiKey}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				clearTimeout(timer);

				if (!res.ok) {
					lastError = new Error(`${step.name} ${res.status}: ${await res.text()}`);
					continue;
				}

				const data = (await res.json()) as IDataObject;
				const choices = (data.choices as IDataObject[]) || [];
				const message = (choices[0]?.message as IDataObject) || {};
				const text = (message.content as string) || '';
				const rawToolCalls = (message.tool_calls as IDataObject[]) || [];

				const toolCalls = rawToolCalls.map((tc) => {
					const fn = (tc.function as IDataObject) || {};
					let args: IDataObject = {};
					try {
						args = JSON.parse((fn.arguments as string) || '{}');
					} catch {
						args = {};
					}
					return { id: tc.id as string, name: fn.name as string, args, type: 'tool_call' as const };
				});

				const aiMessage = new AIMessage({ content: text, tool_calls: toolCalls });
				await runManager?.handleLLMNewToken(text);

				return {
					generations: [{ text, message: aiMessage }],
					llmOutput: { provider: step.name, model: step.model, usage: data.usage ?? null },
				};
			} catch (error) {
				clearTimeout(timer);
				lastError = error as Error;
				continue;
			}
		}

		throw new Error(`All free LLM providers failed. Last error: ${lastError?.message ?? 'unknown'}`);
	}
}

export class PandaLlm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Panda LLM',
		name: 'pandaLlm',
		icon: 'file:pandaLlm.svg',
		group: ['transform'],
		version: 1,
		description:
			'Free-LLM chat model with provider failover. Connect to the Chat Model input of an AI Agent or any chain.',
		defaults: { name: 'Panda LLM' },
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [{ name: 'pandaFreeLlmApi', required: true }],
		properties: [
			{
				displayName: 'Provider',
				name: 'provider',
				type: 'options',
				options: PROVIDER_OPTIONS,
				default: 'groq',
				description: 'The provider to try first',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getModelsForProvider', loadOptionsDependsOn: ['provider'] },
				default: '',
				description: 'Live list of models for the selected provider',
			},
			{
				displayName: 'Enable Failover',
				name: 'failover',
				type: 'boolean',
				default: true,
				description: 'Whether to try other free providers if the primary one fails',
			},
			{
				displayName: 'Fallback Models (in order)',
				name: 'fallbackProviders',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				displayOptions: { show: { failover: [true] } },
				description: 'Tried in order after the primary. Each is a Provider + Model from the live list.',
				default: {
					provider: [
						{ model: `cerebras${VALUE_SEP}${DEFAULT_MODELS.cerebras}` },
						{ model: `gemini${VALUE_SEP}${DEFAULT_MODELS.gemini}` },
						{ model: `openrouter${VALUE_SEP}${DEFAULT_MODELS.openrouter}` },
						{ model: `mistral${VALUE_SEP}${DEFAULT_MODELS.mistral}` },
					],
				},
				options: [
					{
						name: 'provider',
						displayName: 'Fallback',
						values: [
							{
								displayName: 'Provider & Model',
								name: 'model',
								type: 'options',
								typeOptions: { loadOptionsMethod: 'getAllModels' },
								default: '',
								description: 'Live list across every provider you have a key for',
							},
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{ displayName: 'Max Tokens', name: 'maxTokens', type: 'number', default: 1024 },
					{
						displayName: 'Response Format',
						name: 'responseFormat',
						type: 'options',
						options: [
							{ name: 'Text', value: 'text' },
							{ name: 'JSON', value: 'json' },
						],
						default: 'text',
						description: 'Ask the model to return a JSON object instead of free text',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 0.7,
					},
					{ displayName: 'Timeout (Ms)', name: 'timeout', type: 'number', default: 30000 },
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getModelsForProvider(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const service = (this.getCurrentNodeParameter('provider') as string) || 'groq';
				const baseUrl = PROVIDER_BASE_URLS[service];
				const fb: INodePropertyOptions[] = [
					{ name: `${DEFAULT_MODELS[service]} (default)`, value: DEFAULT_MODELS[service] },
				];
				let creds: IDataObject = {};
				try {
					creds = (await this.getCredentials('pandaFreeLlmApi')) as IDataObject;
				} catch {
					return fb;
				}
				const apiKey = ((creds[PROVIDER_CRED_FIELD[service]] as string) || '').trim();
				if (!apiKey) return fb;
				try {
					const response = (await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/models`,
						headers: { Authorization: `Bearer ${apiKey}` },
						json: true,
					})) as IDataObject;
					const data = (response.data as IDataObject[]) || [];
					const ids = data
						.map((m) => m.id as string)
						.filter((id) => !!id)
						.filter((id) => (service === 'openrouter' ? id.endsWith(':free') : true))
						.sort((a, b) => a.localeCompare(b));
					if (ids.length === 0) return fb;
					return ids.map((id) => ({ name: id, value: id }));
				} catch {
					return fb;
				}
			},

			async getAllModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				let creds: IDataObject = {};
				try {
					creds = (await this.getCredentials('pandaFreeLlmApi')) as IDataObject;
				} catch {
					creds = {};
				}
				const results: INodePropertyOptions[] = [];
				for (const service of Object.keys(PROVIDER_BASE_URLS)) {
					const baseUrl = PROVIDER_BASE_URLS[service];
					const apiKey = ((creds[PROVIDER_CRED_FIELD[service]] as string) || '').trim();
					if (!apiKey) continue;
					try {
						const response = (await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/models`,
							headers: { Authorization: `Bearer ${apiKey}` },
							json: true,
						})) as IDataObject;
						const data = (response.data as IDataObject[]) || [];
						const ids = data
							.map((m) => m.id as string)
							.filter((id) => !!id)
							.filter((id) => (service === 'openrouter' ? id.endsWith(':free') : true))
							.sort((a, b) => a.localeCompare(b));
						const list = ids.length ? ids : [DEFAULT_MODELS[service]];
						for (const id of list) {
							results.push({
								name: `${PROVIDER_LABELS[service]} — ${id}`,
								value: `${service}${VALUE_SEP}${id}`,
							});
						}
					} catch {
						results.push({
							name: `${PROVIDER_LABELS[service]} — ${DEFAULT_MODELS[service]} (default)`,
							value: `${service}${VALUE_SEP}${DEFAULT_MODELS[service]}`,
						});
					}
				}
				if (results.length === 0) {
					for (const service of Object.keys(PROVIDER_BASE_URLS)) {
						results.push({
							name: `${PROVIDER_LABELS[service]} — ${DEFAULT_MODELS[service]} (default — add a key)`,
							value: `${service}${VALUE_SEP}${DEFAULT_MODELS[service]}`,
						});
					}
				}
				return results;
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = (await this.getCredentials('pandaFreeLlmApi')) as IDataObject;
		const provider = this.getNodeParameter('provider', itemIndex) as string;
		const selectedModel = (this.getNodeParameter('model', itemIndex, '') as string).trim();
		const useFailover = this.getNodeParameter('failover', itemIndex, true) as boolean;
		const fallbackRows = useFailover
			? (this.getNodeParameter('fallbackProviders.provider', itemIndex, []) as Array<{ model: string }>)
			: [];
		const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

		const temperature = (options.temperature as number) ?? 0.7;
		const maxTokens = (options.maxTokens as number) ?? 1024;
		const timeout = (options.timeout as number) ?? 30000;
		const responseFormat = (options.responseFormat as string) ?? 'text';

		const keyFor = (svc: string) => ((credentials[PROVIDER_CRED_FIELD[svc]] as string) || '').trim();

		const chain: ProviderStep[] = [];
		const seen = new Set<string>();

		const primaryModel = selectedModel || DEFAULT_MODELS[provider];
		if (keyFor(provider)) {
			chain.push({
				name: PROVIDER_LABELS[provider],
				baseUrl: PROVIDER_BASE_URLS[provider],
				apiKey: keyFor(provider),
				model: primaryModel,
			});
			seen.add(`${provider}${VALUE_SEP}${primaryModel}`);
		}

		for (const row of fallbackRows) {
			const raw = (row.model || '').trim();
			if (!raw) continue;
			const sep = raw.indexOf(VALUE_SEP);
			const svc = sep === -1 ? raw : raw.slice(0, sep);
			const mdl = (sep === -1 ? '' : raw.slice(sep + VALUE_SEP.length)) || DEFAULT_MODELS[svc];
			const key = `${svc}${VALUE_SEP}${mdl}`;
			if (!PROVIDER_BASE_URLS[svc] || !keyFor(svc) || seen.has(key)) continue;
			seen.add(key);
			chain.push({ name: PROVIDER_LABELS[svc], baseUrl: PROVIDER_BASE_URLS[svc], apiKey: keyFor(svc), model: mdl });
		}

		const model = new PandaFailoverChat({ chain, temperature, maxTokens, timeout, responseFormat });
		return { response: model };
	}
}
