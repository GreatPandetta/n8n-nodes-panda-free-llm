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

// Base URLs for each provider's OpenAI-compatible API.
const PROVIDER_BASE_URLS: Record<string, string> = {
	groq: 'https://api.groq.com/openai/v1',
	cerebras: 'https://api.cerebras.ai/v1',
	gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
	openrouter: 'https://openrouter.ai/api/v1',
	mistral: 'https://api.mistral.ai/v1',
};

// Which field on the credential holds each provider's key.
const PROVIDER_CRED_FIELD: Record<string, string> = {
	groq: 'groqApiKey',
	cerebras: 'cerebrasApiKey',
	gemini: 'geminiApiKey',
	openrouter: 'openRouterApiKey',
	mistral: 'mistralApiKey',
};

// Human-readable provider labels for the dropdown.
const PROVIDER_LABELS: Record<string, string> = {
	groq: 'Groq',
	cerebras: 'Cerebras',
	gemini: 'Gemini',
	openrouter: 'OpenRouter',
	mistral: 'Mistral',
};

// Fallback model per provider, used if /models can't be reached and as defaults.
const DEFAULT_MODELS: Record<string, string> = {
	groq: 'llama-3.3-70b-versatile',
	cerebras: 'llama-3.3-70b',
	gemini: 'gemini-2.5-flash',
	openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
	mistral: 'mistral-small-latest',
};

// A selected row value is encoded as "<provider>::<modelId>".
const VALUE_SEP = '::';

interface ProviderRow {
	model: string;
}

export class PandaFreeLlm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Panda Free LLM',
		name: 'pandaFreeLlm',
		icon: 'file:pandaFreeLlm.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["userPrompt"] }}',
		description:
			'Send a prompt to several free LLM providers with automatic failover when one is rate-limited or out of quota',
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
				displayName: 'Models (in failover priority order)',
				name: 'providers',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				description:
					'Each row is one Provider + Model, fetched live from the provider. The node tries them top to bottom and returns the first success. Drag to reorder.',
				default: {
					provider: [
						{ model: `groq${VALUE_SEP}${DEFAULT_MODELS.groq}` },
						{ model: `cerebras${VALUE_SEP}${DEFAULT_MODELS.cerebras}` },
						{ model: `gemini${VALUE_SEP}${DEFAULT_MODELS.gemini}` },
						{ model: `openrouter${VALUE_SEP}${DEFAULT_MODELS.openrouter}` },
						{ model: `mistral${VALUE_SEP}${DEFAULT_MODELS.mistral}` },
					],
				},
				options: [
					{
						name: 'provider',
						displayName: 'Model',
						values: [
							{
								displayName: 'Provider & Model',
								name: 'model',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getAllModels',
								},
								default: '',
								description:
									'Live list from every provider you have a key for. Refresh to pull newly added free models.',
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
					{
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						default: 1024,
					},
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
			// Pull the live model list from every provider the user has a key for.
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
							// OpenRouter returns hundreds of models; keep only the free ones.
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
						// Couldn't reach /models — still offer the default so the provider is usable.
						results.push({
							name: `${PROVIDER_LABELS[service]} — ${DEFAULT_MODELS[service]} (default, list unavailable)`,
							value: `${service}${VALUE_SEP}${DEFAULT_MODELS[service]}`,
						});
					}
				}

				// No keys configured yet: offer every provider's default so the node is selectable.
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
				const providerRows = this.getNodeParameter('providers.provider', i, []) as ProviderRow[];
				const options = this.getNodeParameter('options', i, {}) as IDataObject;

				const maxTokens = (options.maxTokens as number) ?? 1024;
				const temperature = (options.temperature as number) ?? 0.7;
				const timeout = (options.timeout as number) ?? 30000;
				const throwOnAllFail = options.throwOnAllFail !== false;

				if (!userPrompt) {
					throw new NodeOperationError(this.getNode(), 'User Prompt is empty', {
						itemIndex: i,
					});
				}

				const attempts: IDataObject[] = [];
				let answered = false;

				for (const row of providerRows) {
					const raw = (row.model || '').trim();
					if (!raw) {
						attempts.push({ skipped: 'empty row' });
						continue;
					}

					const sepIndex = raw.indexOf(VALUE_SEP);
					const service = sepIndex === -1 ? raw : raw.slice(0, sepIndex);
					const selectedModel = sepIndex === -1 ? '' : raw.slice(sepIndex + VALUE_SEP.length);

					const baseUrl = PROVIDER_BASE_URLS[service];
					const apiKey = ((credentials[PROVIDER_CRED_FIELD[service]] as string) || '').trim();
					const model = selectedModel || DEFAULT_MODELS[service];

					if (!baseUrl) {
						attempts.push({ provider: service, skipped: 'unknown provider' });
						continue;
					}
					if (!apiKey) {
						attempts.push({ provider: service, model, skipped: 'no API key in credential' });
						continue;
					}

					try {
						const response = (await this.helpers.httpRequest({
							method: 'POST' as IHttpRequestMethods,
							url: `${baseUrl}/chat/completions`,
							headers: {
								Authorization: `Bearer ${apiKey}`,
								'Content-Type': 'application/json',
							},
							body: {
								model,
								messages: [
									{ role: 'system', content: systemPrompt },
									{ role: 'user', content: userPrompt },
								],
								max_tokens: maxTokens,
								temperature,
							},
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
						returnData.push({
							json: {
								output: text,
								provider: service,
								model,
								usage: response.usage ?? null,
								attempts,
							},
							pairedItem: { item: i },
						});
						answered = true;
						break;
					} catch (error) {
						attempts.push({
							provider: service,
							model,
							error: (error as Error).message,
						});
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
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
