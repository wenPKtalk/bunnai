import { $ } from "bun";
import OpenAI from "openai";
import { readConfigFile } from "./config";
import simpleGit from "simple-git";

interface RunOptions {
  verbose?: boolean;
}

async function getStagedDiff(target_dir: string) {
  try {
    const git = simpleGit(target_dir);
    const diff = await git.diff(["--cached"]);
    return diff;
  } catch (error) {
    console.error("Error getting git diff:", error);
    throw error;
  }
}

async function getCurrentBranchName(target_dir: string): Promise<string> {
  try {
    const git = simpleGit(target_dir);
    const branchSummary = await git.branch();
    return branchSummary.current;
  } catch (error) {
    console.error("Error getting branch name:", error);
    return "unknown-branch";
  }
}

export async function run(options: RunOptions, templateName?: string) {
  const config = await readConfigFile();
  if (options.verbose) {
    console.debug("Configuration loaded successfully.");
  }

  let templateFilePath: string;
  if (templateName) {
    if (!Object.prototype.hasOwnProperty.call(config.templates, templateName)) {
      console.error(
        `Error: Template '${templateName}' does not exist in the configuration.`
      );
      process.exit(1);
    }
    templateFilePath = config.templates[templateName];
    if (options.verbose) {
      console.debug(`Using template: ${templateName}`);
    }
  } else {
    templateFilePath = config.templates.default;
    if (options.verbose) {
      console.debug("Using default template.");
    }
  }

  const templateFile = Bun.file(templateFilePath);
  if (!(await templateFile.exists())) {
    console.error(
      `Error: The template file '${templateFilePath}' does not exist.`
    );
    process.exit(1);
  }
  if (options.verbose) {
    console.debug(`Template file found: ${templateFilePath}`);
  }

  const template = await templateFile.text();
  if (options.verbose) {
    console.debug("Template file read successfully.");
  }

  const target_dir = (await $`pwd`.text()).trim();
  if (options.verbose) {
    console.debug(`Target directory: ${target_dir}`);
  }

  if (!config.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set");
    process.exit(1);
  }

  if (!config.model) {
    console.error("Model is not set");
    process.exit(1);
  }

  const diff = await getStagedDiff(target_dir);
  if (options.verbose) {
    console.debug("Git diff retrieved:\n", diff);
  }

  if (diff.trim().length === 0) {
    console.error(`No changes to commit in ${target_dir}`);
    process.exit(1);
  }

  const branchName = await getCurrentBranchName(target_dir);

  const rendered_template = template.replace("{{diff}}", diff);
  if (options.verbose) {
    console.debug("Template rendered with git diff.");
  }

  const oai = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.openaiEndpoint || "https://api.openai.com/v1",
  });

  try {
    if (options.verbose) {
      console.debug("Sending request to OpenAI...");
    }
    const response = await oai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a commit message generator. I will provide you with a git diff, and I would like you to generate 3 appropriate commit message options using the conventional commit format. Format your response as a numbered list (1., 2., 3.). Make each option distinct and meaningful. Do not write any explanations or other words, just reply with the numbered list of commit messages.",
        },
        {
          role: "user",
          content: rendered_template,
        },
      ],
      model: config.model,
    });

    if (options.verbose) {
      console.debug("Response received from OpenAI.");
      console.debug(JSON.stringify(response, null, 2));
    }

    const aiCommitMessages = response.choices[0].message.content?.trim();
    if (!aiCommitMessages) {
      console.error("Failed to generate commit messages");
      process.exit(1);
    }

    // Split the response into individual messages
    const messageLines = aiCommitMessages.split('\n').filter(line => line.trim().length > 0);
    
    // Format each message with branch name prefix and ensure the numbering is correct
    const formattedMessages = messageLines.map((line, index) => {
      // Extract just the message part (remove the number prefix if it exists)
      const messageMatch = line.match(/^\d+\.\s*(.+)$/);
      const messageContent = messageMatch ? messageMatch[1].trim() : line.trim();
      
      // Format as "number. [branch] message"
      return `${index + 1}. [${branchName}] ${messageContent}`;
    });
    
    // Output each formatted message on a new line
    console.log(formattedMessages.join('\n'));
    
    if (options.verbose) {
      console.debug("Commit messages generated and outputted.");
    }
  } catch (error) {
    console.error(`Failed to fetch from openai: ${error}`);
    process.exit(1);
  }
}