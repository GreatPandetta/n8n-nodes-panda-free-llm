import { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * One credential that stores an (optional) API key for each free provider.
 * Users fill in only the providers they actually have keys for; the node
 * skips any provider whose key is empty.
 */
export class PandaFreeLlmApi implements ICredentialType {
	name = 'pandaFreeLlmApi';

	displayName = 'Panda Free LLM API';

	documentationUrl =
		'https://github.com/YOUR_GITHUB/n8n-nodes-panda-free-llm#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Groq API Key',
			name: 'groqApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Free key from https://console.groq.com/keys',
		},
		{
			displayName: 'Cerebras API Key',
			name: 'cerebrasApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Free key from https://cloud.cerebras.ai',
		},
		{
			displayName: 'Google AI Studio (Gemini) API Key',
			name: 'geminiApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Free key from https://aistudio.google.com/apikey',
		},
		{
			displayName: 'OpenRouter API Key',
			name: 'openRouterApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Free key from https://openrouter.ai/keys',
		},
		{
			displayName: 'Mistral API Key',
			name: 'mistralApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Free key from https://console.mistral.ai/api-keys',
		},
	];
}
