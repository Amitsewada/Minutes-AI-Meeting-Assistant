# Minutes — Direct Speaking Script

## Slide 1 — AI Meeting Assistant

Hello, I am Amit Kumar from Group 43. Our project is Minutes, an AI Meeting Assistant.

Minutes helps users preserve decisions, review AI-generated meeting records and track follow-up tasks in a local project workspace. For example, after a project meeting, the discussion may contain an agreement, a task and a deadline. Minutes organizes that information so it is easier to find and act on later.

The input can be a pasted or imported transcript, or an existing recording that is converted into text. The output contains a summary, decisions, action items, and any supported owners, deadlines or unresolved issues.

The AI result is a draft. The user reviews and confirms it before it becomes the final meeting record.

## Slide 2 — The problem, objective and scope

The first problem is that decisions remain buried in long conversations. Someone may remember that a topic was discussed but forget what was actually agreed. The project response is to save a searchable meeting record together with the original transcript, so the decision and its context can be found again.

The second problem is unclear responsibility after the meeting. A task may be mentioned without everyone remembering who accepted it or when it is due. Minutes extracts action items with owners and deadlines when the transcript supports them. If that information is missing, it stays unspecified rather than being invented.

The third problem is that tasks get forgotten across repeated meetings. Minutes links each action to its originating meeting and organizes meeting history by project. This makes it easier to connect follow-up work with the discussion that created it.

Our main objective is one persistent, editable record for each meeting, with human review before finalization. Persistent means the saved information remains available after refreshing or restarting the application.

## Slide 3 — Application walkthrough: one complete meeting

The workflow starts by saving the source transcript under a project. The AI then creates a draft containing the summary, decisions and action items. The user checks the draft against the source, makes corrections and confirms it.

The confirmed actions become follow-up tasks. Their status can be updated, and the meeting can be found again through project history and search. Audio input adds a transcription and text-review step before the same workflow. Settings provide cloud, local and labelled demo options for text analysis.

For the example on this slide, “Maya will prepare the pilot brief by Friday,” the action is preparing the brief, the owner is Maya, and the stated deadline is Friday. These details still require review, especially before interpreting Friday as a particular calendar date.

## Slide 4 — Technology choices and methodology

React provides the interactive browser interface, including the meeting forms, history, review screens and task controls. Reusable components keep these screens consistent. Vite runs the frontend during development and produces its production build.

Node.js runs the backend, and Express handles API requests and business rules. TypeScript supports shared types across the frontend and backend, which helps catch incompatible data structures during development.

PostgreSQL is provided through PGlite. It stores the application’s data locally without requiring a separate PostgreSQL service installation. This makes the project easier to set up on a laptop while retaining relational storage.

Zod checks data at runtime. It validates user input and the structured AI record, because external data can still be invalid even when the code uses TypeScript.

Groq provides cloud inference, while Ollama is an optional local alternative for text analysis. Both connect through the same application-level interface, so the rest of the workflow uses a consistent result format.

Development was incremental. The transcript, analysis, review and storage workflow came first. Audio input was added after that complete path was working.

## Slide 5 — Architecture and data flow

The React browser handles input and human review. It communicates with the Express backend through an HTTP API using JSON. The backend performs validation, manages processing jobs and connects to the database and AI providers.

The PGlite database stores meetings and tasks. Groq or local Ollama performs the selected text analysis. The browser does not receive the Groq API key; credentials remain on the backend.

The data lifecycle begins by saving the original transcript. The backend then prepares the text, runs analysis and validates the response. Long transcripts are split into manageable chunks when necessary.

The validated result appears as a review draft. The user edits and confirms it, and the backend saves the final record and tasks in one transaction. This keeps those related changes together. Later task-status updates are saved independently.

Audio has an additional first stage. Groq speech recognition converts the recording into text, and the user reviews that text before using it as the meeting transcript. Selecting Ollama for the later analysis does not make audio transcription local.

## Slide 6 — Technical challenges, fixes and evidence

The first challenge was an Ollama grammar failure before generation. The constraints used to describe the expected output were too restrictive for the local generation path. The fix was to simplify those generation constraints while keeping strict Zod checks on the returned result. Simple inference worked, but the lightweight model’s interpretation quality remained limited.

The second challenge involved cancelling an audio request before its job ID reached the browser. At that point, the browser did not yet have the identifier normally used to cancel the job. Cancellation by request key allowed the backend to identify an early request and cancel it. Regression tests covered cancellation at different stages.

The third challenge occurred when a temporary speech job disappeared while the interface kept polling for progress. The application now handles a missing job explicitly, exits the processing state and provides a recovery option such as re-uploading the recording.

These fixes address generation failure, cancellation and recovery. They do not remove the need to review AI interpretation.

## Slide 7 — Current limitations and future scope

The first limitation is AI accuracy. A model can quote words that exist in the transcript but still interpret them incorrectly. Splitting a long transcript can also lose context between sections. Future work includes evaluating representative meeting samples and improving extraction quality and review recovery.

The second limitation is speech input. It currently requires Groq and files within the supported limits. Microphone capture and automatic speaker identification are not implemented. Optional offline speech and microphone input would extend this workflow, but their accuracy and resource use would need evaluation.

The third limitation is deployment. This is a local personal workspace without user accounts, and the application does not encrypt stored meeting content. Shared access would require authentication, authorization, HTTPS and a suitable database deployment.

The fourth limitation is scale. Lists are not paginated, and large-scale performance has not been established. Pagination and load testing are needed before supporting much larger workspaces.

Calendar, Zoom, Meet and Teams integration also remain future work.

## Slide 8 — What is the main objective of your project, and what real-world problem does it solve?

The main objective is to convert meeting transcripts into persistent, structured records that users review before turning commitments into tasks.

The real-world problem is that decisions and responsibilities get lost in long transcripts or scattered notes. Minutes preserves the source, extracts a draft and requires human review before confirmation. Project history keeps related meetings together.

The practical outcome is that users can recover meeting context and track actions linked to the original discussion. The application supports follow-up while keeping the original source available for checking.

## Slide 9 — Why did you choose this specific technology stack or methodology?

React and Node.js follow the proposed web stack and support reusable screens and backend APIs. TypeScript helps keep contracts consistent between the browser and server.

PGlite provides PostgreSQL-based persistence with simpler local installation. Groq and Ollama give the application cloud and local text-analysis options, while Zod validates the common structured record returned by either provider.

The methodology focused on a complete vertical slice: input, analysis, review and persistence. This meant the core user journey worked together before audio was added.

The tradeoff is that this version prioritizes a manageable local setup. A shared public deployment requires additional security and operational work.

## Slide 10 — Can you explain the system architecture and data flow of your application?

The flow has four main stages. First, React sends meeting input to Express. The backend validates it and stores the original transcript in PGlite.

Second, a processing job prepares the transcript and calls Groq or Ollama. The response must pass schema and evidence checks before it becomes a review draft. These checks reduce unsupported output, but they cannot guarantee that every interpretation is correct.

Third, the user reviews and edits the draft. It remains separate from the original transcript, and confirmation is explicit.

Fourth, one transaction saves the final record and its action items. Later task updates are stored independently.

Audio adds a stage before this flow: Groq speech recognition, editable text review and then saving that text as the meeting source.

## Slide 11 — What major technical challenges or bugs did you face, and how did you overcome them?

One major challenge was the Ollama grammar error. Simplifying excessive generation constraints allowed a simple live inference to complete, while strict backend validation remained in place.

Another was the cancellation race during audio upload. The backend could begin work before the browser received a job ID. Adding cancellation by request key made it possible to cancel during that early stage.

A third was handling missing temporary speech jobs. The interface previously risked continuing to poll. Explicit missing-job handling now stops processing and gives the user a clear recovery action.

Regression tests checked these fixes. Model interpretation quality remains a separate limitation, which is why the application still requires human review.

## Slide 12 — What are the key limitations of your system, and what is its future scope?

The main limitations are imperfect AI interpretation, lost context across transcript chunks, cloud-dependent speech processing and the local single-workspace design. There are no user accounts, live microphone recording or meeting-platform integrations.

Future work includes broader quality evaluation, better review recovery, pagination and performance testing. Offline speech and microphone input could extend the input options. Secure team access would require authentication, authorization and deployment changes, with calendar and meeting-platform connections added later.

Minutes currently provides a complete local workflow from meeting input to reviewed records and persistent follow-up tasks. Human review remains central to that workflow. Thank you.
