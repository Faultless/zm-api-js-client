import get from 'lodash/get';
import reduce from 'lodash/reduce';
import {
	BatchRequestOptions,
	BatchRequestResponse,
	JsonRequestOptions,
	Namespace,
	NetworkError,
	ParsedResponse,
	RequestOptions,
	RequestResponse,
	SingleBatchRequestError,
	SingleBatchRequestResponse,
	SOAPHeader
} from './types';

export const DEFAULT_HOSTNAME = '/@zimbra';
export const DEFAULT_SOAP_PATHNAME = '/service/soap';

function soapCommandBody(options: RequestOptions) {
	return {
		_jsns: options.namespace || Namespace.Mail,
		...options.body
	};
}

function parseJSON(response: Response): Promise<ParsedResponse> {
	if (!response.ok) {
		throw networkError(response);
	}

	try {
		return response.json().then(json => {
			(response as ParsedResponse).parsed = json;
			return response;
		});
	} catch (e) {
		(response as ParsedResponse).parseError = e;
		return Promise.resolve(response);
	}
}

function networkError(response: ParsedResponse) {
	const error = new Error(
		`Network request failed with status ${response.status}${
			response.statusText ? `- "${response.statusText}"` : ''
		}`
	);
	(error as NetworkError).response = response;
	(error as NetworkError).parseError = response.parseError;
	return error as NetworkError;
}

function faultReasonText(faults: any = []): string {
	if (!Array.isArray(faults)) faults = [faults];

	return faults
		.map((f: any) => get(f, 'Reason.Text'))
		.filter(Boolean)
		.join(', ');
}

function faultError(response: ParsedResponse, faults: any) {
	const error = new Error(
		`Fault error: ${faults ? faultReasonText(faults) : 'Unknown Error'}`
	);
	(error as SingleBatchRequestError).response = response;
	(error as SingleBatchRequestError).parseError = response.parseError;
	(error as SingleBatchRequestError).faults = faults;
	return error as SingleBatchRequestError;
}

/**
 * Create one key per SOAP command name, with a value
 * containing an array of the requests for that command.
 */
function batchBody(requests: Array<RequestOptions>) {
	return reduce(
		requests,
		(body: { [key: string]: any }, request) => {
			const key = `${request.name}Request`;
			const value = soapCommandBody(request);
			if (body[key]) {
				body[key].push(value);
			} else {
				body[key] = [value];
			}
			return body;
		},
		{}
	);
}

/**
 * For each SOAP command key, flatten it back out
 * into the ordered array that was requested.
 */
function batchResponse(requests: any, response: RequestResponse) {
	const { body: { _jsns: _, ...batchBody }, ...res } = response;

	// For each request type, track which responses have been
	// pulled out of the batch request body by incrementing
	// indexes.
	let indexes: { [key: string]: number } = {};

	return {
		...res,
		requests: reduce(
			requests,
			(
				responses: Array<SingleBatchRequestResponse | SingleBatchRequestError>,
				request
			) => {
				const batchResponses = batchBody[`${request.name}Response`];
				const index = indexes[request.name];
				const response: any = batchResponses && batchResponses[index || 0];
				if (response) {
					responses.push({
						body: response
					});
				} else {
					responses.push(faultError(res.originalResponse, batchBody.Fault));
				}

				if (index) {
					indexes[request.name] += 1;
				} else {
					indexes[request.name] = 1;
				}

				return responses;
			},
			[]
		)
	};
}

export function batchJsonRequest(
	options: BatchRequestOptions
): Promise<BatchRequestResponse> {
	const { requests, ...requestOptions } = options;
	const body = batchBody(requests);

	return jsonRequest({
		...requestOptions,
		name: 'Batch',
		namespace: Namespace.All,
		body
	}).then(res => batchResponse(requests, res));
}

export function jsonRequest(
	requestOptions: JsonRequestOptions
): Promise<RequestResponse> {
	const options = {
		...requestOptions,
		credentials: requestOptions.credentials || 'include',
		headers: requestOptions.headers || {},
		origin: requestOptions.origin || DEFAULT_HOSTNAME,
		soapPathname: requestOptions.soapPathname || DEFAULT_SOAP_PATHNAME,
		namespace: requestOptions.namespace || Namespace.Mail
	};
	const soapRequestName = `${options.name}Request`;
	const soapResponseName = `${options.name}Response`;
	const url = `${options.origin}${options.soapPathname}/${soapRequestName}`;

	let header: SOAPHeader;
	header = {
		context: {
			_jsns: Namespace.All
		}
	};

	if (requestOptions.sessionId) {
		header.context.session = {
			id: requestOptions.sessionId,
			_content: requestOptions.sessionId
		};
	}

	if (requestOptions.sessionSeq) {
		header.context.notify = {
			seq: requestOptions.sessionSeq
		};
	}

	if (requestOptions.accountName) {
		header.context.account = {
			by: 'name',
			_content: requestOptions.accountName
		};
	}

	if (requestOptions.accountId) {
		header.context.account = {
			by: 'id',
			_content: requestOptions.accountId
		};
	}

	const body = {
		[soapRequestName]: soapCommandBody(options)
	};

	return fetch(url, {
		method: 'POST',
		credentials: options.credentials,
		body: JSON.stringify({
			Body: body,
			Header: header
		}),
		headers: options.headers
	})
		.then(parseJSON)
		.then(response => {
			const globalFault = get(response.parsed, 'Body.Fault');

			if (globalFault) {
				throw faultError(response, globalFault);
			}

			return {
				body: response.parsed.Body[soapResponseName],
				header: response.parsed.Header,
				namespace: response.parsed._jsns,
				originalResponse: response
			};
		});
}
