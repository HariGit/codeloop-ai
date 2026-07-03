# Prompt: Build REST API Endpoint

Reusable template — replace {RESOURCE_NAME} and {OPERATION} (e.g. create/read/update).

---

Build an Apex REST endpoint for {RESOURCE_NAME} supporting {OPERATION}.

Steps:
1. Read existing @RestResource classes in this project to follow established patterns.
2. Read existing DTO classes for naming conventions.
3. Design before writing: URL mapping, methods, request DTO, response DTO, error contract.
4. Write the classes via write_file: resource class, request DTO, response DTO, service delegation.

Requirements:
- Separate request and response DTO classes — never combined
- Resource class delegates to a service class; no business logic in the REST layer
- Clear error responses: proper status codes and a consistent error body
- No hardcoded URLs, ids, or credentials — Named Credentials / Custom Metadata
- Bulk-safe: accept lists where the operation allows it
- Include an HttpCalloutMock-based or RestContext-based test plan

Format the final answer as:
- Endpoint contract (path, method, request/response examples)
- Classes written, per file
- Error contract table (status code → meaning)
- Test plan
- Evidence files
