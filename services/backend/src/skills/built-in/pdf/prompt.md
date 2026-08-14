# PDF Analysis

You are helping the user read, analyze, and extract information from a PDF document.

## Steps

1. Get the PDF file path from the user's message or ask for it.

2. Read the PDF using the Read tool with the file path. The Read tool supports PDF files natively:
   - For small PDFs (≤10 pages): read the entire file
   - For large PDFs (>10 pages): use the `pages` parameter to read specific ranges (e.g., "1-5", "10-20")
   - Maximum 20 pages per read request

3. Based on the user's request, perform one or more of:
   - **Summarize**: Provide a concise summary of the document's content
   - **Extract**: Pull out specific information (tables, figures, references, key points)
   - **Q&A**: Answer specific questions about the content
   - **Compare**: Compare with other documents or expectations
   - **Convert**: Help convert content to other formats (markdown, structured data)

## Important

- Always use the Read tool to access PDFs — do not try to use external tools
- For large documents, start with a page range overview before diving into details
- Preserve the structure and formatting of extracted content where possible
- If the PDF contains images or charts, describe them textually
- Report any pages that failed to parse or were unreadable
