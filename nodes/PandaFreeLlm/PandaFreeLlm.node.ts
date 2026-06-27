import {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

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

// Fallback rows encode "<provider>::<modelId>" in a single value.
const VALUE_SEP = '::';

interface FallbackRow {
	model: string;
}

export class PandaFreeLlm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Panda Free LLM',
		name: 'pandaFreeLlm',
		icon: 'file:pandaFreeLlm.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["provider"] + ": " + $parameter["model"] }}',
		description:
			'Send a prompt to a free LLM provider, with automatic failover to other free providers when one is rate-limited or out of quota',
		defaults: {
			name: 'Panda Free LLM',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'pandaFreeLlmApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'System Prompt',
				name: 'systemPrompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: 'You are a helpful assistant.',
				description: 'Fixed instructions sent as the system message on every run',
			},
			{
				displayName: 'User Prompt',
				name: 'userPrompt',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '={{ $json.text }}',
				required: true,
				description:
					'The prompt for this run. Use an expression to map a field from the previous node, e.g. {{ $json.message }}',
			},
			{
				displayName: 'Response Format',
				name: 'responseFormat',
				type: 'options',
				options: [
					{ name: 'Text', value: 'text', description: 'Return the reply as plain text' },
					{
						name: 'JSON',
						value: 'json',
						description:
							'Ask the model for a JSON object and also return it parsed in "outputParsed"',
					},
				],
				default: 'text',
			},
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
				typeOptions: {
					loadOptionsMethod: 'getModelsForProvider',
					loadOptionsDependsOn: ['provider'],
				},
				default: '',
				description:
					'Live list of models for the selected provider. Reopen after changing the provider to refresh.',
			},
			{
				displayName: 'Enable Failover',
				name: 'failover',
				type: 'boolean',
				default: true,
				description:
					'Whether to try other free providers if the primary one fails',
			},
			{
				displayName: 'Fallback Models (in order)',
				name: 'fallbackProviders',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				displayOptions: { show: { failover: [true] } },
				description:
					'Tried top to bottom after the primary. Each row is one Provider + Model from the live list. Drag to reorder.',
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
								description:
									'Live list across every provider you have a key for (OpenRouter shows :free models).',
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
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 0.7,
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 30000,
						description: 'Per-provider request timeout in milliseconds',
					},
					{
						displayName: 'Throw If All Providers Fail',
						name: 'throwOnAllFail',
						type: 'boolean',
						default: true,
						description:
							'Whether to error when every provider fails. Turn off to instead output success:false and continue.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			// Models for the currently selected (top-level) primary provider.
			async getModelsForProvider(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const service = (this.getCurrentNodeParameter('provider') as string) || 'groq';
				const baseUrl = PROVIDER_BASE_URLS[service];
				const fallback: INodePropertyOptions[] = [
					{ name: `${DEFAULT_MODELS[service]} (default)`, value: DEFAULT_MODELS[service] },
				];

				let credentials: IDataObject = {};
				try {
					credentials = (await this.getCredentials('pandaFreeLlmApi')) as IDataObject;
				} catch {
					return fallback;
				}

				const apiKey = ((credentials[PROVIDER_CRED_FIELD[service]] as string) || '').trim();
				if (!apiKey) {
					return [
						{
							name: `${DEFAULT_MODELS[service]} (default — add a ${PROVIDER_LABELS[service]} key to see live models)`,
							value: DEFAULT_MODELS[service],
						},
					];
				}

				try {
					const response = (await this.helpers.httpRequest({
						method: 'GET' as IHttpRequestMethods,
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

					if (ids.length === 0) return fallback;
					return ids.map((id) => ({ name: id, value: id }));
				} catch {
					return fallback;
				}
			},

			// Combined "Provider — Model" list across all providers (for fallback rows).
			async getAllModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				let credentials: IDataObject = {};
				try {
					credentials = (await this.getCredentials('pandaFreeLlmApi')) as IDataObject;
				} catch {
					credentials = {};
				}

				const results: INodePropertyOptions[] = [];

				for (const service of Object.keys(PROVIDER_BASE_URLS)) {
					const baseUrl = PROVIDER_BASE_URLS[service];
					const apiKey = ((credentials[PROVIDER_CRED_FIELD[service]] as string) || '').trim();
					if (!apiKey) continue;

					try {
						const response = (await this.helpers.httpRequest({
							method: 'GET' as IHttpRequestMethods,
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

						if (ids.length === 0) {
							results.push({
								name: `${PROVIDER_LABELS[service]} — ${DEFAULT_MODELS[service]} (default)`,
								value: `${service}${VALUE_SEP}${DEFAULT_MODELS[service]}`,
							});
							continue;
						}

						for (const id of ids) {
							results.push({
								name: `${PROVIDER_LABELS[service]} — ${id}`,
								value: `${service}${VALUE_SEP}${id}`,
							});
						}
					} catch {
						results.push({
							name: `${PROVIDER_LABELS[service]} — ${DEFAULT_MODELS[service]} (default, list unavailable)`,
							value: `${service}${VALUE_SEP}${DEFAULT_MODELS[service]}`,
						});
					}
				}

				if (results.length === 0) {
					for (const service of Object.keys(PROVIDER_BASE_URLS)) {
						results.push({
							name: `${PROVIDER_LABELS[service]} — ${DEFAULT_MODELS[service]} (default — add a key to see live models)`,
							value: `${service}${VALUE_SEP}${DEFAULT_MODELS[service]}`,
						});
					}
				}

				return results;
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = (await this.getCredentials('pandaFreeLlmApi')) as IDataObject;

		for (let i = 0; i < items.length; i++) {
			try {
				const systemPrompt = this.getNodeParameter('systemPrompt', i, '') as string;
				const userPrompt = this.getNodeParameter('userPrompt', i, '') as string;
				const responseFormat = this.getNodeParameter('responseFormat', i, 'text') as string;
				const provider = this.getNodeParameter('provider', i) as string;
				const selectedModel = (this.getNodeParameter('model', i, '') as string).trim();
				const useFailover = this.getNodeParameter('failover', i, true) as boolean;
				const fallbackRows = useFailover
					? (this.getNodeParameter('fallbackProviders.provider', i, []) as FallbackRow[])
					: [];
				const options = this.getNodeParameter('options', i, {}) as IDataObject;

				const maxTokens = (options.maxTokens as number) ?? 1024;
				const temperature = (options.temperature as number) ?? 0.7;
				const timeout = (options.timeout as number) ?? 30000;
				const throwOnAllFail = options.throwOnAllFail !== false;
				const wantJson = responseFormat === 'json';

				if (!userPrompt) {
					throw new NodeOperationError(this.getNode(), 'User Prompt is empty', { itemIndex: i });
				}

				// Build the ordered try-chain: primary first, then fallbacks.
				// Dedupe on provider+model so the same call isn't retried, but the same
				// provider with a different model IS allowed.
				const chain: Array<{ service: string; model: string }> = [];
				const tried = new Set<string>();

				const primaryModel = selectedModel || DEFAULT_MODELS[provider];
				chain.push({ service: provider, model: primaryModel });
				tried.add(`${provider}${VALUE_SEP}${primaryModel}`);

				for (const row of fallbackRows) {
					const raw = (row.model || '').trim();
					if (!raw) continue;
					const sep = raw.indexOf(VALUE_SEP);
					const service = sep === -1 ? raw : raw.slice(0, sep);
					const fbModel =
						(sep === -1 ? '' : raw.slice(sep + VALUE_SEP.length)) || DEFAULT_MODELS[service];
					const key = `${service}${VALUE_SEP}${fbModel}`;
					if (!PROVIDER_BASE_URLS[service] || tried.has(key)) continue;
					tried.add(key);
					chain.push({ service, model: fbModel });
				}

				// JSON mode: OpenAI-compatible APIs expect "json" to appear in the prompt.
				let effectiveSystem = systemPrompt;
				if (wantJson && !/json/i.test(effectiveSystem)) {
					effectiveSystem =
						(effectiveSystem ? effectiveSystem + '\n\n' : '') +
						'Respond with a single valid JSON object only. No markdown, no code fences.';
				}

				const attempts: IDataObject[] = [];
				let answered = false;

				for (const step of chain) {
					const service = step.service;
					const model = step.model;
					const baseUrl = PROVIDER_BASE_URLS[service];
					const apiKey = ((credentials[PROVIDER_CRED_FIELD[service]] as string) || '').trim();

					if (!baseUrl) {
						attempts.push({ provider: service, skipped: 'unknown provider' });
						continue;
					}
					if (!apiKey) {
						attempts.push({ provider: service, model, skipped: 'no API key in credential' });
						continue;
					}

					const body: IDataObject = {
						model,
						messages: [
							{ role: 'system', content: effectiveSystem },
							{ role: 'user', content: userPrompt },
						],
						max_tokens: maxTokens,
						temperature,
					};
					if (wantJson) {
						body.response_format = { type: 'json_object' };
					}

					try {
						const response = (await this.helpers.httpRequest({
							method: 'POST' as IHttpRequestMethods,
							url: `${baseUrl}/chat/completions`,
							headers: {
								Authorization: `Bearer ${apiKey}`,
								'Content-Type': 'application/json',
							},
							body,
							json: true,
							timeout,
						})) as IDataObject;

						const choices = (response.choices as IDataObject[]) || [];
						const message = (choices[0]?.message as IDataObject) || {};
						const text = ((message.content as string) || '').trim();

						if (!text) {
							attempts.push({ provider: service, model, error: 'empty response' });
							continue;
						}

						attempts.push({ provider: service, model, ok: true });

						const json: IDataObject = {
							output: text,
							provider: service,
							model,
							usage: response.usage ?? null,
							attempts,
						};

						if (wantJson) {
							const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
							try {
								json.outputParsed = JSON.parse(cleaned);
							} catch {
								json.outputParsed = null;
								json.parseError = 'Model output was not valid JSON';
							}
						}

						returnData.push({ json, pairedItem: { item: i } });
						answered = true;
						break;
					} catch (error) {
						attempts.push({ provider: service, model, error: (error as Error).message });
						continue;
					}
				}

				if (!answered) {
					if (throwOnAllFail) {
						throw new NodeOperationError(this.getNode(), 'All free LLM providers failed', {
							itemIndex: i,
							description: JSON.stringify(attempts, null, 2),
						});
					}
					returnData.push({
						json: { output: null, success: false, attempts },
						pairedItem: { item: i },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
