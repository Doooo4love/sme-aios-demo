"""Optional Pydantic AI text-to-intent harness. The agent has no executable tools."""
import asyncio

import httpx

from .providers import https_base
from .workbench import PlannedTurn


async def plan_with_model(model, text: str, offered_tools: tuple[str, ...]) -> dict:
    from pydantic_ai import Agent, PromptedOutput, UsageLimits

    agent = Agent(
        model,
        output_type=PromptedOutput(PlannedTurn),
        instructions=(
            "Translate the user's sentence into one supported business intent. "
            "Copy explicit references, warehouse identifiers and dates. "
            "Ask for clarification if required information is missing. "
            "The application decides access and executes actions. "
            "Do not claim anything was found, approved, or executed. "
            "Available operations for this employee: " + ", ".join(offered_tools)
        ),
        retries=0,
    )
    async with asyncio.timeout(10):
        reply = await agent.run(text, usage_limits=UsageLimits(request_limit=1),
                                model_settings={"max_tokens": 450})
    return reply.output.intent.model_dump(mode="json")


class PydanticWorkbenchPlanner:
    def __init__(self, base_url: str, model: str, secret: str):
        self.base_url = https_base(base_url)
        self.model = model
        self.secret = secret

    def plan(self, text: str, offered_tools: tuple[str, ...]) -> dict:
        from openai import AsyncOpenAI, OpenAIError
        from pydantic_ai.exceptions import AgentRunError
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        async def run():
            async with httpx.AsyncClient(timeout=8, trust_env=False, follow_redirects=False) as transport:
                client = AsyncOpenAI(base_url=self.base_url, api_key=self.secret,
                                     http_client=transport, max_retries=0)
                model = OpenAIChatModel(self.model, provider=OpenAIProvider(openai_client=client))
                return await plan_with_model(model, text, offered_tools)

        try:
            return asyncio.run(run())
        except (AgentRunError, OpenAIError) as error:
            raise ValueError("Workbench intent unavailable") from error
