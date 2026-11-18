#!/bin/sh
# LocalStack init: cria as filas SQS FIFO usadas pelo desafio.
# awslocal está disponível dentro do contêiner LocalStack.
#
# A política de redrive precisa do ARN real da DLQ: o account id do LocalStack
# depende das credenciais configuradas, então nunca é seguro fixá-lo no script.

set -eu

ENDPOINT_URL=http://localhost:4566
REGION=us-east-1
DLQ_NAME=wager-transactions-dlq.fifo
QUEUE_NAME=wager-transactions.fifo

COMMON_ATTRS='{"FifoQueue":"true","ContentBasedDeduplication":"true","VisibilityTimeout":"30","MessageRetentionPeriod":"1209600","ReceiveMessageWaitTimeSeconds":"20"}'

echo "Criando fila SQS FIFO: $DLQ_NAME"
awslocal sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --region "$REGION" \
  --endpoint-url "$ENDPOINT_URL" \
  --attributes "$COMMON_ATTRS" >/dev/null 2>&1 || true

DLQ_URL=$(awslocal sqs get-queue-url \
  --queue-name "$DLQ_NAME" \
  --region "$REGION" \
  --endpoint-url "$ENDPOINT_URL" \
  --query 'QueueUrl' --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --region "$REGION" \
  --endpoint-url "$ENDPOINT_URL" \
  --query 'QueueArn' --output text)

REDRIVE_POLICY=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$DLQ_ARN")
# The policy is itself a JSON *string* inside --attributes, so its quotes must
# be escaped before embedding it.
ESCAPED_POLICY=$(printf '%s' "$REDRIVE_POLICY" | sed 's/"/\\"/g')
QUEUE_ATTRS=$(printf '%s' "$COMMON_ATTRS" | sed 's/}$//')
QUEUE_ATTRS="${QUEUE_ATTRS},\"RedrivePolicy\":\"${ESCAPED_POLICY}\"}"

echo "Criando fila SQS FIFO: $QUEUE_NAME"
awslocal sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --region "$REGION" \
  --endpoint-url "$ENDPOINT_URL" \
  --attributes "$QUEUE_ATTRS" >/dev/null 2>&1 || true

echo "Filas SQS prontas. DLQ: $DLQ_ARN"
