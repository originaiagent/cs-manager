import streamlit as st
from typing import Any, Callable, Dict, Optional
from .client import invoke_chat, invoke_workflow, ChatResult, WorkflowResult
from .errors import OriginAiError

def origin_ai_chat_ui(
    title: str = "AI Chat",
    placeholder: str = "Ask me anything...",
    user_id: Optional[str] = None,
):
    """
    Streamlit-based Chat UI component.
    """
    st.subheader(title)
    
    if "messages" not in st.session_state:
        st.session_state.messages = []

    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])

    if prompt := st.chat_input(placeholder):
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        with st.chat_message("assistant"):
            try:
                with st.spinner("AI is thinking..."):
                    result: ChatResult = invoke_chat(prompt, user_id=user_id)
                    st.markdown(result.message)
                    st.session_state.messages.append({"role": "assistant", "content": result.message})
            except OriginAiError as e:
                st.error(f"Error: {e.message}")
                if e.trace_id:
                    st.caption(f"Trace ID: {e.trace_id}")

def origin_ai_workflow_button(
    label: str,
    workflow_id: str,
    data: Dict[str, Any],
    on_success: Optional[Callable[[WorkflowResult], None]] = None,
    key: Optional[str] = None,
):
    """
    Streamlit-based Workflow execution button.
    """
    if st.button(label, key=key):
        try:
            with st.spinner("Executing workflow..."):
                result: WorkflowResult = invoke_workflow(workflow_id, data)
                st.success("Workflow completed successfully!")
                if on_success:
                    on_success(result)
                else:
                    st.write(result.result)
        except OriginAiError as e:
            st.error(f"Workflow Error: {e.message}")
            if e.trace_id:
                st.caption(f"Trace ID: {e.trace_id}")
