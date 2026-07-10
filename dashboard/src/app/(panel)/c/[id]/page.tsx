import { Conversation } from './conversation';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Conversation key={id} conversationId={id} />;
}
